#!/usr/bin/env node
import { scorerStamp } from "../rsi/scorer.js";
import { contextStamp } from "../rsi/context-protocol.js";
import { resolveUsages } from "../audit/usage-cache.js";
/**
 * 《账本》MCP server —— 产品的可插拔形态。
 *
 * 挂到任何支持 MCP 的本地创作 agent（DSH / Claude Code / Cursor / …）上，
 * 让它在**写台词的当下**就被拦住：
 *
 *   agent 想写「苏婉：那笔钱我早就处理了」
 *   → 调 ledger_check
 *   → 「泄漏：苏婉到 S19-02 才被记录得知『苏婉转移了那笔钱』」
 *
 * ## 为什么是 MCP 而不是 skill / 私有插件
 *
 * skill 是**无状态指令包**——它拿不到「跨 60 集累积的账本」，而这正是本产品的前提
 * （design.md §1.2）。MCP server 常驻、有状态、且是 GPT / Claude / Cursor / DSH
 * 的共同形态，所以做一次就能挂在用户各自的 agent 上，不绑死客户端。
 *
 * ## 六个工具（刻意克制：工具定义会为每次模型请求增加 token）
 *
 *   ledger_ingest  首次建账（冻结）
 *   ledger_record  增量并入一场
 *   ledger_check   写台词前调用 ← 命门
 *   ledger_audit   全剧泄漏清单
 *   ledger_page    读一个词条（wiki 形态）
 *   ledger_waive   人工豁免
 *
 * ## 账本落盘位置
 *
 *   LEDGER_HOME（绝对路径）> <cwd>/.ledger
 * 每个工具返回值都带 ledgerPath —— 否则用户不知道产物落在哪。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { checkLine } from "../audit/check.js";
import { buildKnowledge, buildUsages, defaultKnowledge, detectLeaks, type KnowledgeFact } from "../audit/r1.js";
import { extractScenes } from "../extraction/extractor.js";
import { mergeScenes } from "../extraction/merge.js";
import { parseScenes, type Scene } from "../extraction/script.js";
import type { DraftProposition } from "../extraction/types.js";
import { JevProvider } from "../judgment/jev-provider.js";
import { OpenAiCompatProvider } from "../judgment/openai-provider.js";
import type { JudgmentProvider } from "../judgment/types.js";
import {
  appendDecision,
  decisionsPath,
  ledgerHome,
  loadLedger,
  saveLedger,
  summarize,
  type LedgerFile,
  type StoredProposition,
} from "../store/file-store.js";

// stdio 传输占用 stdout，日志一律走 stderr
const log = (...a: unknown[]): void => void console.error("[ledger]", ...a);

/** 从 cwd 的 .env 补配置（客户端通常只传部分 env） */
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
loadEnv(join(process.cwd(), ".env"));

/**
 * 判定层**延迟创建 + 失败计数**。
 *
 * 两次踩过的坑都在这一个函数里：
 *  1. 以前是模块级 `new JevProvider()`：缺 key 时 server 在 import 阶段就抛异常退出，
 *     MCP 客户端看到的是 `-32000 Connection closed` —— 信息量为零。
 *  2. 判定层会**静默降级**：TypeSafe 按地区 451 拒答时，归并每次都退回「NEW」、
 *     usage 校验每次都「保留」，于是工具照样返回一个像样的结果 —— 账本其实一条都没归并。
 *     eval 侧用 `judgeWatch` 治了，产品侧一直没治（回合 44 补上）：
 *     失败计数一非零就在**写盘之前**中止，宁可报错，也不产出「看起来成功」的垃圾账本。
 */
let providerRef: JudgmentProvider | null = null;
const judgeStats = { calls: 0, failed: 0, message: "" };

function provider(): JudgmentProvider {
  if (!providerRef) {
    // 判定层选型：默认 JEV（决策概率，快且便宜）。TypeSafe 会按地区返回 451
    // （"Typesafe is not available in your region"），那种环境下产品**整个建不了账**，
    // 所以留一个显式出口：`LEDGER_JUDGE_PROVIDER=openai` 换任意 OpenAI 兼容判官。
    // 不自动降级 —— 换了判定器就会换出一种账本，必须由使用者自己知道并写进配置。
    const inner: JudgmentProvider =
      (process.env.LEDGER_JUDGE_PROVIDER ?? "").toLowerCase() === "openai"
        ? new OpenAiCompatProvider({ name: "openai-compat" })
        : new JevProvider();
    providerRef = {
      name: inner.name,
      async judge(req) {
        judgeStats.calls += 1;
        try {
          return await inner.judge(req);
        } catch (err) {
          judgeStats.failed += 1;
          if (!judgeStats.message) {
            judgeStats.message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
          }
          throw err;
        }
      },
    };
  }
  return providerRef;
}

function assertJudgeHealthy(stage: string): void {
  if (judgeStats.failed === 0) return;
  throw new Error(
    `${stage}：判定层调用失败 ${judgeStats.failed}/${judgeStats.calls} 次 —— 管线已静默降级（归并会退化成「每条都是新命题」），` +
      `本次结果不可用、也不会写入账本。第一次失败：${judgeStats.message}`,
  );
}

/** 把抽出的 DraftProposition 转成落盘形态 */
function toStored(props: DraftProposition[], existing: StoredProposition[] = []): StoredProposition[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  return props.map((p) => {
    const prev = byId.get(p.id);
    return {
      ...p,
      auditUnit: prev?.auditUnit ?? null,
      aliasSource: Object.fromEntries(p.aliases.map((a) => [a.surface, "extracted" as const])),
    };
  });
}

/** 只建空壳：逐场并入时用（不再「一次抽完整本」） */
function emptyLedger(script: string, series: string): LedgerFile {
  const now = new Date().toISOString();
  return {
    version: 1, series, path: "", script,
    sceneOrder: [], scenes: [], propositions: [], knowledge: [], waivers: [],
    createdAt: now, updatedAt: now,
  };
}

/**
 * 并入一场并**立刻落盘**。
 *
 * 抽出来是为了让 `ledger_record`（用户逐场写）与 `ledger_ingest`（整本建账）
 * 走同一条路 —— 整本建账因此变成**可续跑**的：每场落盘后即使客户端超时，
 * 重试会从断点继续，而不是从头再来。
 */
async function recordScene(ledger: LedgerFile, scene: Scene, series: string): Promise<number> {
  const extracted = await extractScenes([scene], {});
  const merged = await mergeScenes(extracted.scenes, [scene], {
    provider: provider(),
    seed: ledger.propositions,
  });
  assertJudgeHealthy("归并（ledger_record）"); // 写盘之前中止：不让降级结果污染账本
  ledger.propositions = toStored(merged.propositions, ledger.propositions);
  const { facts } = buildKnowledge(ledger.propositions, extracted.scenes);
  const seen = new Set(ledger.knowledge.map((k) => `${k.character}|${k.propositionId}|${k.scene}`));
  for (const f of facts) {
    if (!seen.has(`${f.character}|${f.propositionId}|${f.scene}`)) ledger.knowledge.push(f);
  }
  for (const d of defaultKnowledge(ledger.propositions)) {
    const key = `${d.character}|${d.propositionId}|${d.scene}`;
    if (!seen.has(key)) ledger.knowledge.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)" });
  }
  ledger.scenes.push(scene);
  ledger.sceneOrder.push(scene.id);
  saveLedger(ledger);
  appendDecision({
    at: new Date().toISOString(), kind: "record", series, scene: scene.id,
    newPropositions: extracted.scenes[0]?.propositions.length ?? 0,
  });
  return extracted.scenes[0]?.propositions.length ?? 0;
}

const server = new Server(
  { name: "ledger", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "ledger_ingest",
    description:
      "首次建立剧本账本（抽取命题与知识状态并**冻结**）。同一 series 已存在时会拒绝，除非 overwrite=true。整本剧本较慢（23 场约 35 秒），长剧请改用 ledger_record 逐场并入。返回账本路径与规模。",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "剧本全文（markdown，每场以 `## 场景id` 开头）" },
        series: { type: "string", description: "剧目标识，默认 default" },
        overwrite: { type: "boolean", description: "覆盖已冻结的账本（会丢失既有豁免）" },
      },
      required: ["script"],
    },
  },
  {
    name: "ledger_record",
    description:
      "把**一场**新写的戏并入已有账本（增量，不重扫全本）。写手每完成一场就调用它，账本随写随长。",
    inputSchema: {
      type: "object",
      properties: {
        sceneId: { type: "string", description: "场景 id，如 S21-01" },
        text: { type: "string", description: "该场的正文（台词与叙述，不含 `## ` 标题行）" },
        series: { type: "string", description: "剧目标识，默认 default" },
      },
      required: ["sceneId", "text"],
    },
  },
  {
    name: "ledger_check",
    description:
      "【写完一句台词之前先调这个】判断这句台词是否会构成知识泄漏：说话人用到了他还不该知道的命题。返回命中命题、命中说法、以及是否泄漏与理由。已豁免的会标注 waived。",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "string", description: "要写的台词原文（含说话人前缀亦可）" },
        character: { type: "string", description: "说话人名字" },
        scene: { type: "string", description: "所在场景 id；省略则视为「全剧之后」" },
        series: { type: "string", description: "剧目标识，默认 default" },
      },
      required: ["line", "character"],
    },
  },
  {
    name: "ledger_audit",
    description: "跑全剧 R1 知识泄漏审计，返回问题清单（场景、角色、原句、指向命题、理由）。",
    inputSchema: {
      type: "object",
      properties: { series: { type: "string", description: "剧目标识，默认 default" } },
    },
  },
  {
    name: "ledger_page",
    description: "读一个账本词条：命题表述、全部说法（含首见场景与来源）、施事、知识记录、相关判决流水。",
    inputSchema: {
      type: "object",
      properties: {
        propositionId: { type: "string", description: "命题 id，如 E-012" },
        series: { type: "string", description: "剧目标识，默认 default" },
      },
      required: ["propositionId"],
    },
  },
  {
    name: "ledger_waive",
    description:
      "人工豁免一条误报：记下理由，此后同角色同命题不再报泄漏。豁免是产品的一环（当前误报率还不低），不是补丁。",
    inputSchema: {
      type: "object",
      properties: {
        character: { type: "string", description: "角色名" },
        propositionId: { type: "string", description: "命题 id" },
        reason: { type: "string", description: "豁免理由（会进判决流水，务必写清）" },
        series: { type: "string", description: "剧目标识，默认 default" },
      },
      required: ["character", "propositionId", "reason"],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function text(body: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }] };
}

function needLedger(series: string): LedgerFile {
  const l = loadLedger(ledgerHome(), series);
  if (!l) throw new Error(`没有找到账本。先用 ledger_ingest 建账（查找位置：${ledgerHome()}）`);
  return l;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const series = typeof args.series === "string" && args.series ? args.series : "default";
  const name = req.params.name;

  try {
    switch (name) {
      case "ledger_ingest": {
        const script = String(args.script ?? "");
        if (!script.trim()) throw new Error("script 不能为空");
        // 每次调用只并入一个批次：MCP 客户端的请求默认 60s 超时，
        // 整本一次抽完必然超时（实测 23 场 / 2818 字 → -32001 Request timed out）。
        // 逐场落盘 + 批次预算 ⇒ 超时不再是失败，重试即续跑。
        const allScenes = parseScenes(script);
        const existing = loadLedger(ledgerHome(), series);
        const ledger =
          existing && args.overwrite !== true
            ? existing
            : existing && args.overwrite === true
              ? { ...emptyLedger(script, series), createdAt: existing.createdAt }
              : emptyLedger(script, series);
        const done = new Set(ledger.sceneOrder);
        const todo = allScenes.filter((s) => !done.has(s.id));
        if (existing && args.overwrite !== true && todo.length === 0) {
          throw new Error(
            `账本已冻结（${existing.path}，${existing.propositions.length} 条命题，${done.size} 场已建账），` +
              `这份剧本没有新的场次。新增剧情请用 ledger_record 逐场并入。`,
          );
        }
        // 先落空壳只在**没有既有账本**时才是安全的。`overwrite: true` 会把既有账本清空，
        // 如果这一批随后失败（判定层 451、超时、抽取全挂），空壳会留下来 ——
        // 使用方看到的是「旧账本被清空了」。所以覆盖前先留快照，任何失败都原样写回（回合 52 修）。
        const backup = existing && args.overwrite === true ? existing : null;
        saveLedger(ledger); // 先落空壳/保留既有，保证 path 与后续增量一致

        let ingested = 0;
        const failures: Array<{ scene: string; error: string }> = [];
        try {

        // 主闸是**时间预算**，条数只是上限。
        //
        // ⚠️ 这里必须「一次抽一块、只归并一次」：先按场逐个 recordScene 会让每场都对
        // 全量种子重做归并，复杂度接近平方 —— 实测 23 场会撞穿 60s 超时；
        // 而「整块抽取（内部有界并发）+ 一次归并」只要 15s（抽取 10.3s + 归并 4.5s）。
        const budget = Math.max(1, Number(args.maxScenes ?? process.env.INGEST_MAX_SCENES ?? 40));
        const chunk = todo.slice(0, budget);
        if (chunk.length) {
          const extracted = await extractScenes(chunk, {});
          failures.push(...extracted.failures);
          const merged = await mergeScenes(extracted.scenes, chunk, { provider: provider(), seed: ledger.propositions });
          assertJudgeHealthy("归并（ledger_ingest）"); // 写盘之前中止：这一批不并入账本
          ledger.propositions = toStored(merged.propositions, ledger.propositions);
          const { facts } = buildKnowledge(ledger.propositions, extracted.scenes);
          const seen = new Set(ledger.knowledge.map((k) => `${k.character}|${k.propositionId}|${k.scene}`));
          for (const f of facts) {
            if (!seen.has(`${f.character}|${f.propositionId}|${f.scene}`)) ledger.knowledge.push(f);
          }
          for (const d of defaultKnowledge(ledger.propositions)) {
            const key = `${d.character}|${d.propositionId}|${d.scene}`;
            if (!seen.has(key)) ledger.knowledge.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)" });
          }
          const failedIds = new Set(extracted.failures.map((f) => f.scene));
          for (const s of chunk) {
            if (failedIds.has(s.id)) continue;
            ledger.scenes.push(s);
            ledger.sceneOrder.push(s.id);
            ingested += 1;
          }
          saveLedger(ledger);
        }
        } catch (err) {
          // 覆盖模式下失败：把既有账本原样写回，别让「失败」看起来像「被清空」
          if (backup) saveLedger(backup);
          throw err;
        }
        const remaining = todo.length - ingested - failures.length;
        appendDecision({ at: new Date().toISOString(), kind: "ingest", series, ...summarize(ledger) });
        return text({
          ok: failures.length === 0,
          ...summarize(ledger),
          progress: { total: allScenes.length, done: ledger.sceneOrder.length, thisCall: ingested, remaining },
          ...(remaining > 0
            ? { next: `还有 ${remaining} 场未建账：再用同样的 script 调用一次 ledger_ingest 即可接着建（已建的场次不会重算）。` }
            : {}),
          ...(failures.length ? { failures } : {}),
        });
      }

      case "ledger_record": {
        const sceneId = String(args.sceneId ?? "").trim();
        const body = String(args.text ?? "");
        if (!sceneId || !body.trim()) throw new Error("sceneId 与 text 都必填");
        const ledger = needLedger(series);
        if (ledger.sceneOrder.includes(sceneId)) {
          throw new Error(`场景 ${sceneId} 已在账本里（账本冻结，不重算）。改剧情请用新的场景 id。`);
        }
        const scene: Scene = { id: sceneId, meta: [], lines: body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
        const newProps = await recordScene(ledger, scene, series);
        return text({ ok: true, scene: sceneId, newPropositions: newProps, ...summarize(ledger) });
      }

      case "ledger_check": {
        const ledger = needLedger(series);
        const hits = checkLine(
          {
            line: String(args.line ?? ""),
            character: String(args.character ?? "").trim(),
            scene: typeof args.scene === "string" ? args.scene : undefined,
          },
          ledger.propositions,
          ledger.knowledge,
          ledger.sceneOrder,
          new Set(ledger.waivers.map((w) => w.key)),
        );
        const leaks = hits.filter((h) => h.leak);
        appendDecision({
          at: new Date().toISOString(), kind: "check", series,
          character: String(args.character ?? ""), leaks: leaks.length,
        });
        if (hits.length === 0) {
          return text({ leak: false, hits: [], note: "这句台词没有命中账本里的任何命题" });
        }
        return text({
          leak: leaks.length > 0,
          hits,
          summary: leaks.length
            ? `⚠️ ${leaks.length} 处泄漏：${leaks.map((l) => `「${l.surface}」→ ${l.canonical}`).join("；")}`
            : `没有泄漏（命中 ${hits.length} 条命题，说话人均已知情或已豁免）`,
        });
      }

      case "ledger_audit": {
        const ledger = needLedger(series);
        // 使用点：命中账本缓存则复用（wiki 第三条通道），否则重算并写回
        const stamps = { scorer: scorerStamp("r1"), contextProtocol: contextStamp() };
        const rawUsages = buildUsages(ledger.propositions, ledger.scenes, { skipNames: true }).usages;
        const resolvedU = await resolveUsages(ledger.propositions, { usages: ledger.usages, stamps: ledger.usageStamps }, () => rawUsages, { provider: provider(), verify: process.env.R1_USAGE_VERIFY !== "0", stamps });
        // 校验失败会被「保留该使用点」吞掉 —— 那等于悄悄关掉了 R1_USAGE_VERIFY，账本里别留这种脏缓存
        assertJudgeHealthy("usage 校验（ledger_audit）");
        if (!resolvedU.fromCache) { ledger.usages = resolvedU.usages; ledger.usageStamps = resolvedU.stamps; saveLedger(ledger); }
        const usages = resolvedU.usages;
        const idx = new Map(ledger.sceneOrder.map((s, i) => [s, i]));
        const waived = new Set(ledger.waivers.map((w) => w.key));
        const issues = detectLeaks(ledger.propositions, usages, ledger.knowledge, idx).filter(
          (i) => !waived.has(`${i.character}|${i.propositionId}`),
        );
        appendDecision({ at: new Date().toISOString(), kind: "audit", series, issues: issues.length });
        return text({
          count: issues.length,
          ledgerPath: ledger.path,
          issues: issues.map((i) => ({
            id: `${i.character}|${i.propositionId}`,
            scene: i.useScene,
            character: i.character,
            surface: i.surface,
            line: i.line,
            propositionId: i.propositionId,
            canonical: i.canonical,
            knownAt: i.knownAt,
            reason:
              i.knownAt === null
                ? `全剧没有记录 ${i.character} 得知过这条命题`
                : `${i.character} 到 ${i.knownAt} 才得知，却在 ${i.useScene} 就用了`,
          })),
        });
      }

      case "ledger_page": {
        const ledger = needLedger(series);
        const id = String(args.propositionId ?? "").trim();
        const p = ledger.propositions.find((x) => x.id === id);
        if (!p) throw new Error(`账本里没有命题 ${id}`);
        const decisionsFile = decisionsPath(ledgerHome(), series);
        const related = existsSync(decisionsFile)
          ? readFileSync(decisionsFile, "utf8")
              .split(/\r?\n/)
              .filter((l) => l.includes(id))
              .slice(-20)
          : [];
        return text({
          ...p,
          aliasSourceInfo: "extracted = 从剧本原文抽出；human = 人工添加（评测不认）",
          knowledge: ledger.knowledge.filter((k) => k.propositionId === id),
          decisions: related,
        });
      }

      case "ledger_waive": {
        const ledger = needLedger(series);
        const character = String(args.character ?? "").trim();
        const propositionId = String(args.propositionId ?? "").trim();
        const reason = String(args.reason ?? "").trim();
        if (!character || !propositionId || !reason) throw new Error("character / propositionId / reason 都必填");
        const key = `${character}|${propositionId}`;
        if (!ledger.waivers.some((w) => w.key === key)) {
          ledger.waivers.push({ key, character, propositionId, reason, at: new Date().toISOString() });
          saveLedger(ledger);
        }
        appendDecision({ at: new Date().toISOString(), kind: "waive", series, key, reason });
        return text({ ok: true, key, waivers: ledger.waivers.length, ledgerPath: ledger.path });
      }

      default:
        throw new Error(`未知工具：${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${name} 失败：${message}`);
    return { content: [{ type: "text" as const, text: `错误：${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`已启动 · LEDGER_HOME=${ledgerHome()}`);

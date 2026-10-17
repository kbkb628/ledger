import { verifyUsages } from "../src/audit/usage-verify.js";
import { contextStamp } from "../src/rsi/context-protocol.js";
import { scorerStamp } from "../src/rsi/scorer.js";
import { formatRate } from "../src/rsi/metrics.js";
import { stamp, loadRegistry } from "../src/rsi/testset.js";
/**
 * R1 真阳性验证 —— 在**故意写坏的**剧本上测精确率与召回率。
 *
 * ## 为什么需要这个（以及它测的不是什么）
 *
 * 正本《旧账》是内部自洽的，一条真泄漏都没有 —— 在它上面 R1 只能产出误报，
 * 精确率恒为 0，也演示不了产品能力。
 *
 * 所以另建 `eval/script-leak.md`：故意注入 3 处泄漏（无源 / 时序），
 * 同时保留 6 条「应当被放过」的台词。标注在 `eval/leaks.json`。
 *
 * ## 口径
 *
 * - **真阳性**：报出的问题命中一条标注泄漏（角色 + 说法 + 场景）
 * - **假阳性**：报出的问题不命中任何标注
 * - **假阴性**：标注的泄漏没被抓到
 * - `must_not_flag` 命中的会单独点名 —— 那些是**设计上明确应当放过的**
 *   （当事人、亲历、当场看到、误信、本职），被抓到就是设计错误而非精度问题
 *
 * 用法：
 *   npm run eval:r1               # 用缓存
 *   npm run eval:r1 -- --fresh    # 重跑抽取 + 归并（约 $0.01 / 12s）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { auditOnUnits, buildKnowledge, buildUsages, defaultKnowledge, detectLeaks } from "../src/audit/r1.js";
import { writeTaskResult } from "../src/eval/report.js";
import { buildNormalizer, extractCharacters, type CharacterEntry } from "../src/extraction/characters.js";
import { promoteUnits } from "../src/extraction/promote.js";
import { extractScenes, type ExtractResult } from "../src/extraction/extractor.js";
import { mergeScenes, type MergeResult } from "../src/extraction/merge.js";
import { parseScenes } from "../src/extraction/script.js";
import { JevProvider } from "../src/judgment/jev-provider.js";
import { OpenAiCompatProvider } from "../src/judgment/openai-provider.js";
import type { JudgmentProvider } from "../src/judgment/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.R1_SCRIPT ?? join(here, "script-leak.md");
const LEAKS = process.env.R1_LEAKS ?? join(here, "leaks.json");
// ⚠️ 缓存默认值必须跟着标注集走：跨剧本留出集若共用 pipeline-leak.json，一次 --fresh
// 就会把 dev 的抽取缓存覆盖成另一份剧本的，此后 `npx tsx eval/run-r1.ts` 拿到的是错的账本
// 而看不出任何异常。用 R1_CACHE 显式覆盖仍优先。
const CACHE =
  process.env.R1_CACHE ??
  join(here, "out", LEAKS === join(here, "leaks.json") ? "pipeline-leak.json" : `pipeline-${basename(LEAKS, ".json")}.json`);

interface Annotation {
  id: string;
  kind: "no_source" | "timing";
  character: string;
  scene: string;
  surface: string;
  why: string;
  exact_scene: boolean;
  split: "dev" | "holdout";
}
interface MustNotFlag { character: string; scene: string; surface: string; why: string }
interface LeaksFile {
  meta: { name: string };
  leaks: Annotation[];
  must_not_flag: MustNotFlag[];
}
/**
 * RSI 变体开关 —— **每个都默认关闭或保持已成基线**，改动只在打开时生效。
 *
 * 为什么这样设计（用户明确要求：「措施不要反而让效果更差、引入噪声，RSI 要能回退」）：
 *   - 任何一招不删代码，只换开关 → 变差了一条命令关掉，不用 revert 一堆 diff
 *   - 每轮必须记 `docs/rsi-protocol.md` 的回合表：commit + 开关组合 + 实测数字
 *   - 上游（抽取/归并）用 `--reuse` 冻结，**只变 R1 层**，避免把「JEV 抖动」误判成「改动有效」
 */
function flag(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v !== "0" && v !== "false";
}

const FLAGS = {
  /** 施事 ⇒ 知道（已基线化：实测误报 23 → 18） */
  agent: flag("R1_AGENT", true),
  /** 命题首见场景的在场者 ⇒ 知道 */
  presence: flag("R1_PRESENCE", true),
  /** R1 跑在审计单元层（需 promotion；实测在小样本上 promotion 退化成单元素组） */
  units: flag("R1_UNITS", false),
  /** 归并判定时附人物别称表（实测让 P/R 从 66.7% 掉到 50%/33.3% → 默认关闭） */
  charHint: flag("R1_CHAR_HINT", false),
  /** 用判定层校验 usage 是否真引用（治「碰巧共享词」假命中） */
  usageVerify: flag("R1_USAGE_VERIFY", true),
  /** 不得用自己台词作为自己知情来源（治 masked_by_presence） */
  noSelfEstablish: flag("R1_NO_SELF_ESTABLISH", false),
  /** 过滤「纯人名」说法（提到人名 ≠ 使用命题，真实剧本测试暴露） */
  nameSkip: flag("R1_NAME_SKIP", true),
  /** 在场者规则改从「确立场」起算（治 masked_by_presence） */
  established: flag("R1_ESTABLISHED", false),
  /** 用派生识别键匹配短引用（测「说法匹配」这一条成因） */
  shortKey: flag("R1_SHORTKEY", false),
};

interface CacheShape {
  extracted: ExtractResult;
  merged: MergeResult;
  characters: CharacterEntry[];
}


function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const strip = (s: string): string => s.replace(/[\s。，、！？：；「」（）·—…]/g, "");

/**
 * 判定层选型：`R1_JUDGE_PROVIDER=jev|openai`（默认 jev）。
 *
 * 为什么必须可换：TypeSafe 直连会按地区拒答（实测 451 `Typesafe is not available
 * in your region`），而项目里本来就有一条等价协议的另一实现（`OpenAiCompatProvider`）。
 * 换 provider 会改变**账本**（归并结果），所以它进的是版本指纹 `RSI_FLAG_NAMES`，
 * 与 `EXTRACT_MODEL` 同级 —— 不在打分器戳里。
 */
function makeJudgeProvider(): JudgmentProvider {
  const kind = (process.env.R1_JUDGE_PROVIDER ?? "jev").toLowerCase();
  return kind === "openai" ? new OpenAiCompatProvider() : new JevProvider();
}

/**
 * 判定失败必须炸，不能静默降级。
 *
 * 实测教训：JEV 区域封锁时，`mergeScenes` 对每一次失败都退回 "NEW"、
 * `verifyUsages` 对每一次失败都保留使用点 —— 两边都"尽力而为"，
 * 于是 run-r1 打印出一个像样的 P/R，而账本其实**一条都没归并**、使用点**一条都没校验**。
 * 这不是能力问题，是绿灯失效，必须在写结果之前中止。
 */
// .env 必须在构造 provider **之前**加载：provider 是在构造时读 JUDGE_* / JEV_* 的
loadEnv(join(here, "..", ".env"));

const judgeWatch = (() => {
  const inner = makeJudgeProvider();
  const stats = { name: inner.name, calls: 0, failed: 0, message: "" as string };
  const provider: JudgmentProvider = {
    name: inner.name,
    async judge(req) {
      stats.calls += 1;
      try {
        return await inner.judge(req);
      } catch (e) {
        stats.failed += 1;
        if (!stats.message) stats.message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        throw e;
      }
    },
  };
  return { provider, stats };
})();

function failIfDegraded(stage: string): boolean {
  if (judgeWatch.stats.failed === 0) return false;
  console.log(
    `\n❌ ${stage}：判定调用失败 ${judgeWatch.stats.failed}/${judgeWatch.stats.calls} 次 —— ` +
      `管线已静默降级（合并退化为全 NEW / 使用点校验全保留），本次数字不可用。\n   第一次失败：${judgeWatch.stats.message}\n`,
  );
  process.exitCode = 1;
  return true;
}

/**
 * 标注集文件 → 注册表里的 `id@ver#hash`。
 *
 * 以前这里硬写 `stamp("leaks")`：一旦用 R1_LEAKS 换了另一份标注，结果里记的仍是
 * dev 集的戳 —— 正是「这个数字是哪个版本跑出来的」要避免的那种错答案。
 */
function testsetStampOf(file: string): string | null {
  const rel = file.replace(/\\/g, "/");
  const hits = loadRegistry().sets.filter((s) => s.files.some((f) => rel.endsWith(f.replace(/\\/g, "/"))));
  if (!hits.length) return null;
  return stamp(hits[hits.length - 1]!.id);
}
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

async function loadCache(): Promise<CacheShape> {
  if (process.argv.includes("--reuse") && existsSync(CACHE)) {
    return JSON.parse(readFileSync(CACHE, "utf8")) as CacheShape;
  }
  if (!process.argv.includes("--fresh") && existsSync(CACHE)) {
    return JSON.parse(readFileSync(CACHE, "utf8")) as CacheShape;
  }
  const scenes = parseScenes(readFileSync(SCRIPT, "utf8"));

  console.log(`【人物别称】`);
  const chars = await extractCharacters(scenes, { verbose: true });
  const normalize = buildNormalizer(chars.characters);

  console.log(`【抽取】${scenes.length} 场`);
  const extracted = await extractScenes(scenes, { verbose: true });
  console.log(`【归并】（输入已做人物别称归一）`);
  const merged = await mergeScenes(extracted.scenes, scenes, {
    provider: judgeWatch.provider,
    normalize,
    characterHint: FLAGS.charHint
      ? chars.characters
          .filter((c) => c.aliases.length > 0)
          .map((c) => `${c.name} = ${c.aliases.join(" = ")}`)
          .join("\n")
      : undefined,
    verbose: true,
  });
  const cache: CacheShape = { extracted, merged, characters: chars.characters };
  if (judgeWatch.stats.failed > 0) {
    // 落盘就会把「全 NEW」的账本变成下一次的默认输入 —— 宁可重抽
    console.log(`⚠️ 归并阶段有 ${judgeWatch.stats.failed} 次判定失败，本次不写缓存`);
  } else {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache, null, 2), "utf8");
  }
  return cache;
}

async function main(): Promise<void> {
  loadEnv(join(here, "..", ".env"));
  // 标注集在文件头解析：默认 script-leak 的标注；跨剧本留出集用 R1_LEAKS 指向另一份
  // （如 R1_SCRIPT=eval/script-jiuzhang-leak.md R1_LEAKS=eval/leaks-jiuzhang.json）
  const ann = JSON.parse(readFileSync(LEAKS, "utf8")) as LeaksFile;
  const setStamp = testsetStampOf(LEAKS);
  if (!setStamp) console.log(`⚠️ 标注集未在 evalsets/index.json 登记：${LEAKS}（结果里的 testset 记为 null）`);
  // ── 留出集封存：默认只用 dev 裁决；--holdout 才解封 ──
  const useHoldout = process.argv.includes("--holdout");
  const scoredLeaks = ann.leaks.filter((a) => useHoldout || a.split === "dev");
  const sealed = ann.leaks.filter((a) => a.split === "holdout").length;
  const scenes = parseScenes(readFileSync(SCRIPT, "utf8"));
  const sceneOrder = new Map(scenes.map((s, i) => [s.id, i]));
  const cache = await loadCache();
  // 降级时**不落缓存**：否则下一次不带 --fresh 的运行会静默复用「全 NEW」的账本
  if (judgeWatch.stats.calls > 0 && failIfDegraded("归并")) return;
  const ledger = cache.merged.propositions;

  // 判定层校验 usage（R1_USAGE_VERIFY）：过滤「碰巧共享词」的假使用点
  const { facts } = buildKnowledge(ledger, cache.extracted.scenes);
  const defaults = defaultKnowledge(ledger, scenes, { agent: FLAGS.agent, presence: FLAGS.presence, established: FLAGS.established, noSelfEstablish: FLAGS.noSelfEstablish });
  for (const d of defaults) {
    facts.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)", source: "default" });
  }
  const usagesRes = buildUsages(ledger, scenes, { shortKeys: FLAGS.shortKey, skipNames: FLAGS.nameSkip, minLen: Number(process.env.R1_MIN_SURFACE_LEN ?? 3) });
  let usages = usagesRes.usages;

  // 语义校验必须在 buildUsages 之后（需要候选使用点）
  if (FLAGS.usageVerify) {
    const vr = await verifyUsages(usages, ledger, { provider: judgeWatch.provider });
    console.log(`【usage 校验】保留 ${vr.kept} / 丢弃 ${vr.dropped} / UNSURE ${vr.unsure}　${vr.calls} 次调用 $${vr.costUsd.toFixed(4)}　${(vr.latencyMs / 1000).toFixed(1)}s`);
    // 每次失败都被静默「保留」——那等于关掉了 R1_USAGE_VERIFY，不能当真结果
    if (failIfDegraded("usage 校验")) return;
    usages = vr.usages;
  }

  // ── 把知识与使用一并提升到审计单元层，再跑 R1 ──
  //
  // 实测依据（test-plan.md §5.11）：同一事实被抽成三条命题（E-004/E-005/E-007），
  // 告知记录挂在一条、使用点在另一条，**按命题比对永远对不上**。
  // 知识是关于「那个秘密」的，使用也是，所以必须在单元层比对。
  const useUnits = FLAGS.units;
  const promoCache = join(here, "out", "promotion-leak.json");
  let unitOf = new Map<string, string>();
  if (useUnits) {
    let clusters: Array<{ unit: string; label: string; members: string[] }>;
    if (!process.argv.includes("--fresh") && existsSync(promoCache)) {
      clusters = (JSON.parse(readFileSync(promoCache, "utf8")) as { clusters: typeof clusters }).clusters;
    } else {
      console.log(`【promotion】把 ${ledger.length} 条细事实归并成审计单元`);
      const pr = await promoteUnits(ledger, { verbose: true });
      clusters = pr.clusters;
      mkdirSync(dirname(promoCache), { recursive: true });
      writeFileSync(promoCache, JSON.stringify({ clusters }, null, 2), "utf8");
    }
    for (const c of clusters) for (const id of c.members) unitOf.set(id, c.unit);
  }

  const { issues, units } = useUnits
    ? auditOnUnits(ledger, usages, facts, sceneOrder, unitOf)
    : { issues: detectLeaks(ledger, usages, facts, sceneOrder), units: ledger };

  console.log(`\n${"─".repeat(62)}`);
  console.log(`账本 : ${ledger.length} 条命题 / ${usages.length} 个使用点 / ${facts.length} 条知识状态`);
  console.log(`报出 : ${issues.length} 条问题${FLAGS.shortKey ? `（识别键新增使用点 ${usagesRes.keyMatches}）` : ""}`);
  console.log(`判定 : ${judgeWatch.stats.name}（${judgeWatch.stats.calls} 次调用，失败 ${judgeWatch.stats.failed}）`);

  // ── 匹配标注 ──
  const hitLeak = new Set<string>();
  const fps: typeof issues = [];
  const flaggedMustNot = new Map<string, string>();
  /** 给执行器采集的轨迹（每条一行 JSON） */
  const trace: string[] = [];

  for (const iss of issues) {
    const surface = strip(iss.surface);
    const matched = scoredLeaks.filter(
      (a) =>
        a.character === iss.character &&
        (a.exact_scene ? a.scene === iss.useScene : true) &&
        (surface.includes(strip(a.surface)) || strip(a.surface).includes(surface)),
    );
    if (matched.length > 0) {
      for (const m of matched) hitLeak.add(m.id);
      trace.push(JSON.stringify({ kind: "issue", verdict: "true_positive", matched: matched.map((m) => m.id), scene: iss.useScene, character: iss.character, surface: iss.surface, propositionId: iss.propositionId }));
      continue;
    }
    // 命中「应当放过」的标注 → 设计错误，单独点名
    const mn = ann.must_not_flag.find(
      (m) =>
        m.character === iss.character &&
        (m.scene === iss.useScene || true) &&
        (surface.includes(strip(m.surface)) || strip(m.surface).includes(surface)),
    );
    if (mn) flaggedMustNot.set(`${mn.character}|${mn.surface}`, iss.useScene);
    fps.push(iss);
    // 桶的判定留给组件 3（评测器升级）；这里只把原料记全
    trace.push(JSON.stringify({ kind: "issue", verdict: mn ? "should_allow" : "false_positive", scene: iss.useScene, character: iss.character, surface: iss.surface, propositionId: iss.propositionId, mustNotFlag: mn ? `${mn.character}|${mn.surface}` : null }));
  }

  const missed = scoredLeaks.filter((a) => !hitLeak.has(a.id));
  const tp = hitLeak.size;
  const fp = fps.length;
  const fn = missed.length;

  // ── 逐条报 ──
  console.log(`\n${"═".repeat(62)}\n注入的泄漏 ${scoredLeaks.length} 处${useHoldout ? "（含 holdout）" : `　·　holdout ${sealed} 条已封存（--holdout 解封）`}:`);
  for (const a of ann.leaks) {
    const got = hitLeak.has(a.id);
    console.log(`  ${got ? "✅ 抓到" : "❌ 漏掉"}  ${a.id}（${a.kind === "timing" ? "时序" : "无源"}）${a.scene} ${a.character}「${a.surface}」`);
    if (!got) console.log(`       ${a.why.slice(0, 70)}`);
  }

  if (missed.length) {
    console.log(`\n漏掉的原因排查（这些命题在账本里存在吗）：`);
    for (const a of missed) {
      const needle = strip(a.surface);
      const owners = ledger.filter((p) => p.aliases.some((x) => strip(x.surface).includes(needle) || needle.includes(strip(x.surface))));
      console.log(`  ${a.id}「${a.surface}」→ 账本里含该说法的命题: ${owners.length ? owners.map((p) => p.id).join("/") : "（无）"}`);
      for (const p of owners) {
        const knows = facts.filter((f) => f.character === a.character && f.propositionId === p.id);
        console.log(`      ${p.id} ${p.canonical.slice(0, 34)}　${a.character} 的知识记录 ${knows.length} 条`);
      }
      // 桶的原料：命题是否存在、该处有没有使用点、最早的知情记录来自哪里
      const usageAtSite = usages.some(
        (u) => u.scene === a.scene && u.character === a.character && owners.some((p) => p.id === u.propositionId),
      );
      const knowledge = owners
        .flatMap((p) => facts.filter((f) => f.character === a.character && f.propositionId === p.id))
        .sort((x, y) => (sceneOrder.get(x.scene) ?? 0) - (sceneOrder.get(y.scene) ?? 0));
      const earliest = knowledge[0];

      trace.push(
        JSON.stringify({
          kind: "annotation",
          verdict: "missed",
          id: a.id,
          leakKind: a.kind,
          scene: a.scene,
          character: a.character,
          surface: a.surface,
          ownerPropositions: owners.map((p) => p.id),
          usageAtSite,
          earliestKnowledge: earliest
            ? { scene: earliest.scene, source: earliest.source ?? "extracted", evidence: earliest.evidence }
            : null,
          knowledgeCounts: owners.map((p) => ({
            propositionId: p.id,
            total: facts.filter((f) => f.character === a.character && f.propositionId === p.id).length,
            fromDefault: facts.filter((f) => f.character === a.character && f.propositionId === p.id && f.source === "default").length,
          })),
        }),
      );
    }
  }

  if (flaggedMustNot.size) {
    console.log(`\n⚠️ 被误报的「应当放过」台词（设计错误，不是精度问题）:`);
    for (const [k, scene] of flaggedMustNot) console.log(`  ${k} @${scene}`);
  }

  console.log(`\n${"─".repeat(62)}`);
  console.log(`精确率 ${formatRate(tp, tp + fp)}（95% Wilson 区间）`);
  console.log(`召回率 ${formatRate(tp, tp + fn)}（95% Wilson 区间）`);
  console.log(`误报   ${fp} 条`);

  if (fps.length) {
    console.log(`\n误报明细:`);
    for (const f of fps) {
      console.log(`  ${f.useScene} ${f.character}「${f.surface}」→ ${f.canonical.slice(0, 30)}`);
    }
  }

  console.log(`\n抽取成本 $${cache.extracted.costUsd.toFixed(4)} + 归并 $${cache.merged.costUsd.toFixed(4)}\n`);

  // ── 交给任务执行器（设了 RSI_RUN_DIR 才写文件；逻辑与数字完全不变）──
  writeTaskResult(
    {
      task: "r1",
      metrics: {
        tp,
        fp,
        fn,
        reported: tp + fp,
        precision: tp + fp === 0 ? 0 : tp / (tp + fp),
        recall: tp + fn === 0 ? 0 : tp / (tp + fn),
        annotations: scoredLeaks.length,
      },
      extra: {
        devSet: { version: ann.meta.name, size: scoredLeaks.length },
        split: useHoldout ? "all" : "dev",
        testset: setStamp,
        scorer: scorerStamp("r1"),
        contextProtocol: contextStamp(),
        ledger: { propositions: ledger.length, usages: usages.length, knowledge: facts.length },
        flags: FLAGS,
        judgeProvider: judgeWatch.stats.name,
        ledgerCache: CACHE,
        flaggedMustNot: [...flaggedMustNot.entries()],
      },
      evalCost: {
        // --reuse 时上游是缓存，**没有新的真实花费**，报 0 以免控制器把历史成本算进本轮预算
        usd: process.argv.includes("--reuse") ? 0 : cache.extracted.costUsd + cache.merged.costUsd,
        seconds: 0,
      },
    },
    trace,
  );
}

await main();

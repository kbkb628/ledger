import { scorerStamp } from "../src/rsi/scorer.js";
import { formatRate } from "../src/rsi/metrics.js";
import { stamp } from "../src/rsi/testset.js";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditOnUnits, buildKnowledge, buildUsages, defaultKnowledge, detectLeaks } from "../src/audit/r1.js";
import { writeTaskResult } from "../src/eval/report.js";
import { buildNormalizer, extractCharacters, type CharacterEntry } from "../src/extraction/characters.js";
import { promoteUnits } from "../src/extraction/promote.js";
import { extractScenes, type ExtractResult } from "../src/extraction/extractor.js";
import { mergeScenes, type MergeResult } from "../src/extraction/merge.js";
import { parseScenes } from "../src/extraction/script.js";
import { JevProvider } from "../src/judgment/jev-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.R1_SCRIPT ?? join(here, "script-leak.md");
const CACHE = process.env.R1_CACHE ?? join(here, "out", "pipeline-leak.json");

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
    provider: new JevProvider(),
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
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache, null, 2), "utf8");
  return cache;
}

async function main(): Promise<void> {
  loadEnv(join(here, "..", ".env"));
  const ann = JSON.parse(readFileSync(join(here, "leaks.json"), "utf8")) as LeaksFile;
  // ── 留出集封存：默认只用 dev 裁决；--holdout 才解封 ──
  const useHoldout = process.argv.includes("--holdout");
  const scoredLeaks = ann.leaks.filter((a) => useHoldout || a.split === "dev");
  const sealed = ann.leaks.filter((a) => a.split === "holdout").length;
  const scenes = parseScenes(readFileSync(SCRIPT, "utf8"));
  const sceneOrder = new Map(scenes.map((s, i) => [s.id, i]));
  const cache = await loadCache();
  const ledger = cache.merged.propositions;

  const { facts } = buildKnowledge(ledger, cache.extracted.scenes);
  const defaults = defaultKnowledge(ledger, scenes, { agent: FLAGS.agent, presence: FLAGS.presence, established: FLAGS.established });
  for (const d of defaults) {
    facts.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)", source: "default" });
  }
  const usagesRes = buildUsages(ledger, scenes, { shortKeys: FLAGS.shortKey, skipNames: FLAGS.nameSkip });
  const usages = usagesRes.usages;

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
        testset: stamp("leaks"),
        scorer: scorerStamp("r1"),
        ledger: { propositions: ledger.length, usages: usages.length, knowledge: facts.length },
        flags: FLAGS,
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

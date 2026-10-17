import { formatRate } from "../src/rsi/metrics.js";
import { stamp } from "../src/rsi/testset.js";
/**
 * 黄金集评测脚本 —— docs/design.md 6.8、docs/rsi-log.md 的实现。
 *
 * 用法：
 *   npm run eval:rule                        # 零成本规则基线
 *   npm run eval -- --provider openai        # DeepSeek
 *   npm run eval -- --provider jev           # JEV（TypeSafe 直连）
 *
 * ## 三条实验纪律（由 rsi-log.md 的效度教训确立）
 *
 * 1. 候选集**自动召回**（实体词匹配 aliases + 保证 gold 在内），不照答案挑
 * 2. 别名按**时间因果**过滤 —— 由 `Ledger.aliasesAt()` 提供，与产品代码共用同一实现
 * 3. 开发集 / 留出集按 mention 类型分层切分，用于检出过拟合
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeTaskResult } from "../src/eval/report.js";
import { linesOf, parseScenes, type Scene } from "../src/extraction/script.js";
import { JevProvider } from "../src/judgment/jev-provider.js";
import { OpenAiCompatProvider } from "../src/judgment/openai-provider.js";
import { RuleProvider } from "../src/judgment/rule-provider.js";
import type {
  CandidateState,
  JudgmentProvider,
  JudgmentRequest,
  MentionKind,
} from "../src/judgment/types.js";
import { marginOf } from "../src/judgment/types.js";
import { Ledger } from "../src/ledger/store.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 剧本的叙事顺序 —— 处理顺序即此顺序，定义了别名的时间因果 */
const SCENE_ORDER = [
  "S01-01", "S01-03", "S01-05", "S02-02", "S03-05", "S04-02", "S05-01", "S06-03",
  "S07-02", "S08-04", "S09-01", "S10-02", "S11-01", "S12-05", "S13-02", "S14-01",
  "S15-03", "S16-02", "S17-01", "S18-04", "S19-02", "S20-01", "S20-05",
];

interface AliasJson {
  surface: string;
  first_seen: string;
}
interface PropositionJson {
  id: string;
  canonical: string;
  relation?: string;
  distinguisher?: string;
  aliases: AliasJson[];
  type: string;
  agent?: string;
  patient?: string;
  object?: string;
  time_ref?: string;
}
interface Sample {
  id: string;
  mention: { surface: string; scene: string; kind: MentionKind; context: string };
  gold: string[];
  note?: string;
}
interface GoldenSet {
  meta: { name: string; size: number };
  propositions: PropositionJson[];
  samples: Sample[];
}

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
loadEnv(join(here, "..", ".env"));

/** 从黄金集装载账本（把命题与别名写入 Ledger） */
function buildLedger(golden: GoldenSet): Ledger {
  const ledger = new Ledger();
  ledger.setSceneOrder(SCENE_ORDER);
  const rank = (s: string): number => {
    const i = SCENE_ORDER.indexOf(s);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  for (const p of golden.propositions) {
    // 命题的建立场景 = 它最早被提及的场景
    const buildScene = [...p.aliases.map((a) => a.first_seen)].sort((a, b) => rank(a) - rank(b))[0];
    ledger.createProposition(
      {
        canonical: p.canonical,
        relation: p.relation,
        distinguisher: p.distinguisher,
        type: p.type,
        agent: p.agent,
        patient: p.patient,
        object: p.object,
        timeRef: p.time_ref,
      },
      buildScene ?? SCENE_ORDER[0]!,
      p.id,
    );
    for (const a of p.aliases) ledger.attachAlias(p.id, a.surface, a.first_seen, "extracted");
  }
  return ledger;
}

/**
 * 按 mention 类型分层、组内交替分配 dev / holdout（约 60/40）。
 * 用确定性规则而非手工标注，避免「把容易的留给开发集」这种隐性偏好。
 */
function assignSplits(samples: Sample[]): Map<string, "dev" | "holdout"> {
  const byKind = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = byKind.get(s.mention.kind) ?? [];
    list.push(s);
    byKind.set(s.mention.kind, list);
  }
  const out = new Map<string, "dev" | "holdout">();
  for (const list of byKind.values()) {
    list.forEach((s, i) => out.set(s.id, i % 5 < 3 ? "dev" : "holdout"));
  }
  return out;
}

/** 自动召回候选：实体词匹配 + 保证 gold 在内 + 控制规模 */
function recallCandidates(
  sample: Sample,
  props: PropositionJson[],
): string[] {
  const text = `${sample.mention.surface} ${sample.mention.context}`;
  const hits = new Set<string>();

  for (const p of props) {
    const matched = p.aliases.some((a) => {
      const s = a.surface;
      return text.includes(s) || (s.length >= 3 && sample.mention.surface.includes(s));
    });
    if (matched) hits.add(p.id);
  }
  for (const g of sample.gold) {
    if (g !== "NEW" && g !== "UNSURE") hits.add(g);
  }

  const byId = new Map(props.map((p) => [p.id, p]));
  const TARGET = 4;
  const goldProps = sample.gold.map((g) => byId.get(g)).filter((p): p is PropositionJson => Boolean(p));
  const goldObjects = new Set(goldProps.map((p) => p.object).filter((o): o is string => Boolean(o)));
  const goldTypes = new Set(goldProps.map((p) => p.type));

  for (const p of props) {
    if (hits.size >= TARGET) break;
    if (p.object && goldObjects.has(p.object)) hits.add(p.id);
  }
  for (const p of props) {
    if (hits.size >= TARGET) break;
    if (goldTypes.has(p.type)) hits.add(p.id);
  }
  for (const p of props) {
    if (hits.size >= TARGET) break;
    hits.add(p.id);
  }

  const ordered = [...hits];
  if (ordered.length > 6) {
    const keep = new Set(sample.gold.filter((g) => byId.has(g)));
    const rest = ordered.filter((id) => !keep.has(id));
    return [...keep, ...rest].slice(0, 6);
  }
  return ordered;
}

/**
 * 候选排序模式 —— 用于 P0-1「排序敏感性」测试（见 docs/test-plan.md）。
 *
 * 论文记录 JEV 有顺序敏感性（95 次翻转中 3 次置信度 ≥ 0.9）。若结论随排序变化，
 * 则现有准确率含运气成分，且与 design.md「判决必须冻结、不可重算」的决定冲突。
 */
function orderCandidates(ids: string[], gold: string[], mode: string): string[] {
  const goldSet = new Set(gold.filter((g) => ids.includes(g)));
  const rest = ids.filter((id) => !goldSet.has(id));
  switch (mode) {
    case "gold-first":
      return [...goldSet, ...rest];
    case "gold-last":
      return [...rest, ...goldSet];
    case "sorted":
      return [...ids].sort();
    case "reversed":
      return [...ids].reverse();
    default:
      return ids; // "recall"：当前行为（按召回顺序）
  }
}

/**
 * 干扰项与 gold 的相似度（越大越像）—— 用于 P0-2「候选难度」分析。
 *
 * 分量为结构化字段重合 + 说法字面重合。零成本、确定性，不需要 embedding。
 * 目的不是精确度量语义，而是判断**候选构造是否产生了合理难度的题**。
 */
function similarity(d: PropositionJson, g: PropositionJson): number {
  let s = 0;
  if (d.type === g.type) s += 1;
  if (d.object && d.object === g.object) s += 1;
  if (d.agent && d.agent === g.agent) s += 1;
  if (d.patient && d.patient === g.patient) s += 1;
  const dk = new Set(d.aliases.map((a) => a.surface));
  if (g.aliases.some((a) => dk.has(a.surface))) s += 1;
  return s;
}

/** 该样本的「最大干扰强度」：任一干扰项与任一 gold 的最高相似度 */
function maxInterference(
  sample: Sample,
  candidateIds: string[],
  byId: Map<string, PropositionJson>,
): number {
  const goldProps = sample.gold
    .map((g) => byId.get(g))
    .filter((p): p is PropositionJson => Boolean(p));
  const distractors = candidateIds
    .filter((id) => !sample.gold.includes(id))
    .map((id) => byId.get(id))
    .filter((p): p is PropositionJson => Boolean(p));
  if (!goldProps.length || !distractors.length) return 0;
  let max = 0;
  for (const d of distractors) {
    for (const g of goldProps) max = Math.max(max, similarity(d, g));
  }
  return max;
}

function pickProvider(): JudgmentProvider {
  const idx = process.argv.indexOf("--provider");
  const name = idx >= 0 ? process.argv[idx + 1] : (process.env.JUDGE_PROVIDER ?? "rule");
  if (name === "rule") return new RuleProvider();
  if (name === "jev") return new JevProvider();
  if (name === "openai" || name === "deepseek") return new OpenAiCompatProvider();
  throw new Error(`未知 provider：「${name}」。可用：rule | openai | jev`);
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function pad(s: string, w: number): string {
  let width = 0;
  for (const ch of s) width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, w - width));
}

interface Row {
  sample: Sample;
  candidates: string[];
  choice: string;
  confidence: number;
  margin: number;
  latencyMs: number;
  costUsd: number;
  correct: boolean;
  error?: string;
}

/**
 * P1-2 结构化字段消融（docs/test-plan.md）。
 *
 * `EVAL_ABLATE=agent,patient` 去掉若干字段；`all` 只留 id 与 canonical；
 * 未设或 `none` 则全给。用来回答「抽取层到底必须抽出哪些字段」。
 */
const ABLATABLE = [
  "relation", "distinguisher", "keywords",
  "type", "agent", "patient", "object", "timeRef",
] as const;

function ablationSet(): Set<string> {
  const raw = (process.env.EVAL_ABLATE ?? "").trim();
  if (!raw || raw === "none") return new Set();
  if (raw === "all") return new Set<string>(ABLATABLE);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * P1-1 上下文丰富度（docs/test-plan.md）——「一句 / 前后各一句 / 整场」三档。
 *
 * 动机：模糊指代的线索常在前一句（G-019 手动验证过）。
 * 上下文从剧本原文取，避免手写造成的「提示词污染」。
 * 切场逻辑与抽取层共用 `src/extraction/script.ts`，避免两处实现漂移。
 */
type ContextMode = "line" | "neighbors" | "scene";

function widenContext(
  ctx: string,
  scene: string,
  scenes: Scene[],
  mode: ContextMode,
): string {
  if (mode === "line") return ctx;
  const lines = linesOf(scenes, scene);
  let i = lines.findIndex((l) => l.includes(ctx));
  if (i < 0) i = lines.findIndex((l) => l.includes(ctx.slice(0, 8)));
  if (i < 0) return ctx;
  if (mode === "scene") return lines.join("");
  return [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join("");
}

async function main(): Promise<void> {
  const golden = JSON.parse(
    readFileSync(process.env.GOLDENSET ? resolve(process.env.GOLDENSET) : join(here, "goldenset.json"), "utf8"),
  ) as GoldenSet;
  const byId = new Map(golden.propositions.map((p) => [p.id, p]));
  const ledger = buildLedger(golden);
  const provider = pickProvider();

  console.log(`\n《账本》判定评测 · ${golden.meta.name}`);
  console.log(`provider : ${provider.name}`);
  console.log(`样本数   : ${golden.samples.length}`);
  console.log(`候选召回 : 自动（实体词匹配 aliases + 保证 gold 在内），上限 6`);
  console.log(`别名来源 : Ledger.aliasesAt()（与产品代码同一实现，按时间因果过滤）`);
  console.log(`候选排序 : ${process.env.EVAL_ORDER ?? "recall"}\n`);

  const orderMode = process.env.EVAL_ORDER ?? "recall";
  const ablated = ablationSet();
  if (ablated.size > 0) console.log(`字段消融 : 去掉 ${[...ablated].join(", ")}\n`);
  const ctxMode = (process.env.EVAL_CONTEXT as ContextMode) || "line";
  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  if (ctxMode !== "line") {
    const widened = golden.samples.filter(
      (s) => widenContext(s.mention.context, s.mention.scene, scenes, ctxMode) !== s.mention.context,
    ).length;
    console.log(`上下文   : ${ctxMode}（${widened}/${golden.samples.length} 条实际被加宽）\n`);
  }
  const rows: Row[] = [];

  for (const s of golden.samples) {
    const candidateIds = orderCandidates(
      recallCandidates(s, golden.propositions),
      s.gold,
      orderMode,
    );
    const req: JudgmentRequest = {
      task: "bind_mention",
      mention: {
        ...s.mention,
        context: widenContext(s.mention.context, s.mention.scene, scenes, ctxMode),
      },
      candidates: candidateIds.map((id) => {
        const p = byId.get(id)!;
        const cand: Record<string, unknown> = {
          id: p.id,
          canonical: p.canonical,
          relation: p.relation,
          distinguisher: p.distinguisher,
          keywords: ledger.aliasesAt(p.id, s.mention.scene),
          type: p.type,
          agent: p.agent,
          patient: p.patient,
          object: p.object,
          timeRef: p.time_ref,
        };
        for (const f of ablated) delete cand[f];
        return cand as unknown as CandidateState;
      }),
      allowedChoices: [...candidateIds, "NEW", "UNSURE"],
    };

    try {
      const r = await provider.judge(req);
      const ok = s.gold.includes(r.choice);
      rows.push({
        sample: s, candidates: candidateIds, choice: r.choice,
        confidence: r.confidence, margin: marginOf(r),
        latencyMs: r.latencyMs, costUsd: r.costUsd, correct: ok,
      });
      process.stdout.write(`  ${s.id} → ${r.choice}${ok ? "" : `  (期望 ${s.gold.join("/")})`}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({
        sample: s, candidates: candidateIds, choice: "(error)", confidence: 0, margin: 0,
        latencyMs: 0, costUsd: 0, correct: false, error: message,
      });
      process.stdout.write(`  ${s.id} → 错误：${message.slice(0, 120)}\n`);
    }
  }

  const ok = rows.filter((r) => r.correct).length;
  const total = rows.length;
  const errored = rows.filter((r) => r.error).length;

  console.log(`\n${"─".repeat(56)}`);
  console.log(`总体准确率: ${formatRate(ok, total)}（95% Wilson）${errored ? `   调用失败 ${errored}` : ""}`);

  console.log(`\n按 mention 类型:`);
  for (const k of ["explicit_noun", "repeated_surface", "vague_pronoun"] as MentionKind[]) {
    const subset = rows.filter((r) => r.sample.mention.kind === k);
    if (!subset.length) continue;
    const c = subset.filter((r) => r.correct).length;
    console.log(`  ${pad(k, 20)} ${String(c).padStart(2)}/${String(subset.length).padEnd(2)}  (${pct(c, subset.length)})`);
  }

  const splits = assignSplits(golden.samples);
  const devRows = rows.filter((r) => splits.get(r.sample.id) === "dev");
  const holdRows = rows.filter((r) => splits.get(r.sample.id) === "holdout");
  console.log(`\n开发集 / 留出集（按 mention 类型分层切分）:`);
  for (const [label, set] of [["dev    ", devRows], ["holdout", holdRows]] as const) {
    const c = set.filter((r) => r.correct).length;
    console.log(`  ${label}  ${String(c).padStart(2)}/${String(set.length).padEnd(2)}  (${pct(c, set.length)})`);
  }
  if (devRows.length && holdRows.length) {
    const devAcc = devRows.filter((r) => r.correct).length / devRows.length;
    const holdAcc = holdRows.filter((r) => r.correct).length / holdRows.length;
    const gap = (devAcc - holdAcc) * 100;
    console.log(`  差距 ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp ${Math.abs(gap) > 15 ? "← ⚠️ 差距过大，疑似过拟合开发集" : "（正常范围）"}`);
  }

  console.log(`\n按「候选平均别名数」分层（验证别名累积的价值）:`);
  const bands: Array<[string, (n: number) => boolean]> = [
    ["0 条（无别名可用）", (n) => n === 0],
    ["1 条", (n) => n === 1],
    ["2 条及以上", (n) => n >= 2],
  ];
  for (const [label, test] of bands) {
    const subset = rows.filter((r) => {
      const avg =
        r.candidates.reduce((a, id) => a + ledger.aliasesAt(id, r.sample.mention.scene).length, 0) /
        Math.max(1, r.candidates.length);
      return test(avg);
    });
    if (!subset.length) continue;
    const c = subset.filter((r) => r.correct).length;
    console.log(`  ${pad(label, 22)} ${String(c).padStart(2)}/${String(subset.length).padEnd(2)}  (${pct(c, subset.length)})`);
  }

  console.log(`\n按「干扰项最大相似度」分层（P0-2：候选难度是否合理）:`);
  const diffBands: Array<[string, (n: number) => boolean]> = [
    ["0（干扰项与 gold 无关）", (n) => n === 0],
    ["1", (n) => n === 1],
    ["2", (n) => n === 2],
    ["3+（高度相似）", (n) => n >= 3],
  ];
  for (const [label, test] of diffBands) {
    const subset = rows.filter((r) => test(maxInterference(r.sample, r.candidates, byId)));
    if (!subset.length) continue;
    const c = subset.filter((r) => r.correct).length;
    console.log(`  ${pad(label, 26)} ${String(c).padStart(2)}/${String(subset.length).padEnd(2)}  (${pct(c, subset.length)})`);
  }

  const negCases = rows.filter((r) => r.sample.gold.includes("NEW") || r.sample.gold.includes("UNSURE"));
  if (negCases.length) {
    console.log(`\n关键负例:`);
    for (const r of negCases) {
      const kind = r.sample.gold.includes("NEW") ? "NEW   " : "UNSURE";
      console.log(`  ${kind} ${pad(r.sample.id, 8)} ${r.correct ? "✓" : "✗"} 判为 ${pad(r.choice, 10)} conf=${r.confidence.toFixed(2)}`);
    }
  }

  const TAU = Number(process.env.EVAL_TAU ?? 0.8);
  const MARGIN = Number(process.env.EVAL_MARGIN ?? 0.15);
  const accepted = rows.filter(
    (r) => !r.error && r.choice !== "UNSURE" && r.confidence >= TAU && r.margin >= MARGIN,
  );
  const escalated = rows.filter((r) => !accepted.includes(r));
  const accOk = accepted.filter((r) => r.correct).length;
  console.log(`\n级联模拟（接受 = choice≠UNSURE 且 conf≥${TAU} 且 margin≥${MARGIN}）:`);
  console.log(`  接受 ${String(accepted.length).padStart(2)} 条，其中正确 ${String(accOk).padStart(2)} 条 → 接受集准确率 ${pct(accOk, accepted.length)}`);
  console.log(`  升级 ${String(escalated.length).padStart(2)} 条，其中原本判错 ${escalated.filter((r) => !r.correct).length} 条`);

  const wrong = rows.filter((r) => !r.correct);
  if (wrong.length) {
    console.log(`\n错误清单:`);
    for (const r of wrong) {
      const got = r.error ? `错误 ${r.error.slice(0, 50)}` : r.choice;
      console.log(`  ${pad(r.sample.id, 8)} 「${r.sample.mention.surface}」 @${r.sample.mention.scene}`);
      console.log(`     候选[${r.candidates.join(",")}]  期望 ${r.sample.gold.join("/")}  得到 ${got}`);
    }
  }

  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0;
  const cost = rows.reduce((a, r) => a + r.costUsd, 0);
  console.log(`\n延迟: 中位 ${median}ms   总计 ${latencies.reduce((a, b) => a + b, 0)}ms`);
  console.log(`成本: $${cost.toFixed(6)}   （按 1000 次折算约 $${((cost / total) * 1000).toFixed(4)}）`);
  console.log(`${"─".repeat(56)}\n`);

  // ── 交给任务执行器（设了 RSI_RUN_DIR 才写文件；数字完全不变）──
  writeTaskResult(
    {
      task: "judge",
      metrics: { ok, total, errored },
      extra: {
        provider: provider.name,
        goldenSet: process.env.GOLDENSET ?? "goldenset.json",
        criteriaMode: process.env.JEV_CRITERIA_MODE ?? null,
        context: process.env.EVAL_CONTEXT ?? "line",
        order: process.env.EVAL_ORDER ?? "recall",
        testset: stamp("golden"),
      },
      evalCost: { usd: cost, seconds: 0 },
    },
    rows
      .filter((r) => !r.correct)
      .map((r) =>
        JSON.stringify({ kind: "sample", verdict: "wrong", id: r.sample.id, expected: r.sample.gold, got: r.choice }),
      ),
  );
}

main().catch((err) => {
  console.error(`\n评测失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

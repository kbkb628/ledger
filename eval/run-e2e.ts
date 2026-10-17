/**
 * 端到端评测 —— **这才是产品的真实指标**。
 *
 * ## 为什么不用「抽取 vs golden 别名召回」
 *
 * 那个指标被**粒度**混淆：golden 的 14 条命题是「审计单元」（如「苏婉伪造并调换了遗嘱」
 * 算一条），而抽取层产出的是更细的客观事实（「伪造」与「调换」两条）。
 * 于是一条 golden 命题的别名会天然分散到两三条抽出命题上 ——
 * **别名召回对 golden 的上限大概就在 50% 附近，无论抽取做得多好。**
 * 用它优化等于在优化一个测不出东西的尺子。
 *
 * ## 真正的指标
 *
 * 产品的用户路径是：剧本 → 账本 → 「这句话指的是哪条命题」。
 * 所以直接测最后一步：**拿抽取出来的账本，去回答黄金集的 48 个 mention**，
 * 和 golden 的标注比。这个指标对粒度**稳健** ——
 * 只要那个说法被抽出来了、且能通过判定挂到正确的命题上，就算对，
 * 不管账本里的命题切得比 golden 粗还是细。
 *
 * ## 口径
 *
 * - 候选**从抽取账本召回**（不是从 golden 召回）—— 这才是产品行为
 * - 每条 mention 的 `gold` 是 golden 命题 id，先经一对一指派翻译成账本 id；
 *   翻译不过去（该命题没被覆盖）= 这条**不可答**，计入分母，不算对
 * - 判定配置沿用已验证的最优：`keywords` criteria + 上下文前后各一句
 *
 * 用法：
 *   npx tsx eval/run-e2e.ts
 *   npx tsx eval/run-e2e.ts --provider rule    # 零成本下限
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assignPropositions, diceBigram, matchInfo, pairScore, type PropositionLike } from "./match.js";
import type { ExtractResult } from "../src/extraction/extractor.js";
import type { MergeResult } from "../src/extraction/merge.js";
import { promoteUnits, type PromoteResult } from "../src/extraction/promote.js";
import { writeTaskResult } from "../src/eval/report.js";
import { parseScenes, type Scene } from "../src/extraction/script.js";
import type { DraftProposition } from "../src/extraction/types.js";
import { JevProvider } from "../src/judgment/jev-provider.js";
import { RuleProvider } from "../src/judgment/rule-provider.js";
import type { JudgmentProvider, JudgmentRequest, MentionKind } from "../src/judgment/types.js";
import { marginOf } from "../src/judgment/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.EXTRACT_CACHE ?? join(here, "out", "pipeline-v1.json");

interface GoldenAlias { surface: string; first_seen: string }
interface GoldenProposition { id: string; canonical: string; aliases: GoldenAlias[] }
interface Sample {
  id: string;
  mention: { surface: string; scene: string; kind: MentionKind; context: string };
  gold: string[];
}
interface GoldenSet {
  meta: { name: string };
  propositions: Array<GoldenProposition & { audit_unit?: string }>;
  samples: Sample[];
}
interface CacheShape { extracted: ExtractResult; merged: MergeResult }

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

const pct = (n: number, d: number): string => (d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1)}%`);

function widenContext(ctx: string, scene: string, scenes: Scene[]): string {
  const lines = scenes.find((s) => s.id === scene)?.lines ?? [];
  let i = lines.findIndex((l) => l.includes(ctx));
  if (i < 0) i = lines.findIndex((l) => l.includes(ctx.slice(0, 8)));
  if (i < 0) return ctx;
  return [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join("");
}

/**
 * 从抽取账本召回候选 —— 产品里的 blocking。
 *
 * ## 为什么必须补齐到 4 条（这一版修过，见 test-plan.md §5.7）
 *
 * 抽取账本的别名比人工账本稀疏（44 条说法 / 25 条命题 vs 76 / 18），
 * 于是 alias 匹配经常只命中 **1 条**。而 JEV 是 decision-only 的比较机器：
 * 候选只有一条时，它会把 NEW 当成更安全的答案 —— 实测造成 4/7 的
 * `judge_negative`。**这是评测协议的锅，不是模型的锅。**
 *
 * `rsi-log.md` 的实验纪律第 3 条本来就要求「候选集规模 ≥ 4」，
 * 这一条在 `run-eval.ts` 里实现了，`run-e2e.ts` 漏了。
 *
 * ## 补齐用什么挑（这一点很关键）
 *
 * 三种策略实测差异显著（`E2E_PAD` 切换，见 test-plan.md §5.7）：
 *
 * | 策略 | 补齐依据 | 效果 |
 * |---|---|---|
 * | `none` | 不补 | 常出现**只有 1 条候选**的退化问题，判定器倾向说 NEW |
 * | `sim`  | 字符 bigram 相似度 | 干扰项与正确答案高度相似，难度被人为抬高 |
 * | `id`   | 命题 id 顺序（中立）**← 标准** | 既避免退化问题，又不人为加难度 |
 *
 * 绝不能像某些做法那样「用 gold 的 object/type 去找相似候选」—— 那是照答案挑，
 * 会让难度虚低（rsi-log 效度教训）。
 */
const MIN_CANDIDATES = 4;
type PadMode = "none" | "sim" | "id";

function padMode(): PadMode {
  const m = (process.env.E2E_PAD ?? "id").trim();
  return m === "none" || m === "sim" ? m : "id";
}

function recall(
  sample: Sample,
  props: DraftProposition[],
  sceneIndex: Map<string, number>,
  goldIds: string[],
): string[] {
  const surface = sample.mention.surface;
  const cur = sceneIndex.get(sample.mention.scene) ?? Number.MAX_SAFE_INTEGER;
  const scored = new Map<string, number>();

  for (const p of props) {
    let score = 0;
    for (const a of p.aliases) {
      // 时序过滤：只能用「首次出现不晚于当前场景」的说法（rsi-log 实验纪律 2）
      if ((sceneIndex.get(a.firstSeen) ?? Number.MAX_SAFE_INTEGER) > cur) continue;
      const m = matchInfo(surface, a.surface);
      if (m) score += m.len;
    }
    if (score > 0) scored.set(p.id, score);
  }

  // 保证 gold 在候选里（否则测的是召回而不是判定）。不给它虚高分数，
  // 以免把「gold 永远排第一」这个信息偷偷塞给判定器（P0-1 证明排序携带信息）。
  for (const g of goldIds) if (!scored.has(g)) scored.set(g, 1);

  const mode = padMode();
  if (mode !== "none" && scored.size < MIN_CANDIDATES) {
    const mentionText = `${surface}${sample.mention.context}`;
    const rest = props.filter((p) => !scored.has(p.id));
    const ordered =
      mode === "sim"
        ? rest
            .map((p) => ({
              id: p.id,
              sim: diceBigram(mentionText, `${p.canonical} ${p.aliases.map((a) => a.surface).join(" ")}`),
            }))
            .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id))
            .map((x) => x.id)
        : rest.map((p) => p.id).sort(); // id 顺序：中立，不偏向相似也不偏向无关
    for (const id of ordered) {
      if (scored.size >= MIN_CANDIDATES) break;
      scored.set(id, 0.5); // 补齐的候选，分数低于任何字面命中
    }
  }

  // P0-1 的结论：候选顺序携带信息，必须稳定排序（按分数降序，同分按 id）
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([id]) => id);
}

function pickProvider(): JudgmentProvider {
  const idx = process.argv.indexOf("--provider");
  const name = idx >= 0 ? process.argv[idx + 1] : (process.env.E2E_PROVIDER ?? "jev");
  return name === "rule" ? new RuleProvider() : new JevProvider();
}

async function main(): Promise<void> {
  loadEnv(join(here, "..", ".env"));

  if (!existsSync(CACHE)) {
    console.log(`缺少流水线缓存 ${CACHE} —— 先跑 npm run eval:extract -- --fresh`);
    return;
  }
  const golden = JSON.parse(
    readFileSync(process.env.GOLDENSET ? resolve(process.env.GOLDENSET) : join(here, "goldenset.json"), "utf8"),
  ) as GoldenSet;
  const cache = JSON.parse(readFileSync(CACHE, "utf8")) as CacheShape;
  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, i]));

  const ledger = cache.merged.propositions;
  const provider = pickProvider();

  // golden 命题 id → 账本命题 id（一对一指派）
  const assign = assignPropositions(golden.propositions, ledger);
  const toLedger = new Map<string, string>();
  for (const [gid, p] of assign) toLedger.set(gid, p.id);

  // 审计单元：golden 命题 → 它属于哪个「秘密」。
  // 账本命题的单元**按最佳匹配的 golden 命题继承**，而不是按一对一指派继承 ——
  // 否则没被指派的账本命题（就是被抽取层拆出来的那些）会没有单元，
  // 于是「同单元误判」会被错算成「跨单元语义错误」。
  const unitOf = new Map<string, string>();
  for (const g of golden.propositions) if (g.audit_unit) unitOf.set(g.id, g.audit_unit);
  const ledgerUnit = new Map<string, string>();
  for (const p of ledger) {
    let bestU: string | undefined;
    let bestScore = 0;
    for (const g of golden.propositions) {
      const { score } = pairScore(g.aliases, p);
      if (score > bestScore) {
        bestScore = score;
        bestU = unitOf.get(g.id);
      }
    }
    if (bestU) ledgerUnit.set(p.id, bestU);
  }

  // ── 可选：用 promotion 层产出的审计单元替换「golden 推导的单元」 ──
  //
  // 同一个指标算两遍：
  //   --promote 关闭 → 用 golden 的 audit_unit（这是**收益上限**，不是真实能力）
  //   --promote 开启 → 用 promotion 层**自己**算出来的分组（这才是产品能拿到的）
  let activeUnit = ledgerUnit;
  if (process.argv.includes("--promote")) {
    const cachePath = join(here, "out", "promotion.json");
    let pr: PromoteResult;
    if (existsSync(cachePath) && !process.argv.includes("--fresh")) {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as {
        clusters: PromoteResult["clusters"]; costUsd: number; latencyMs: number;
        missed: string[]; duplicated: string[];
      };
      const unitOf = new Map<string, string>();
      for (const c of raw.clusters) for (const id of c.members) unitOf.set(id, c.unit);
      pr = { ...raw, unitOf };
      console.log(`\n【promotion】读自缓存：${raw.clusters.length} 个审计单元`);
    } else {
      console.log(`\n【promotion】把 ${ledger.length} 条细事实归并成审计单元`);
      pr = await promoteUnits(ledger, { verbose: true });
      writeFileSync(
        cachePath,
        JSON.stringify({ clusters: pr.clusters, costUsd: pr.costUsd, latencyMs: pr.latencyMs, missed: pr.missed, duplicated: pr.duplicated }, null, 2),
        "utf8",
      );
    }
    activeUnit = pr.unitOf;

    // 分群质量：与 golden 推导的单元做**成对**比对（pairwise P/R）
    const ids = ledger.map((p) => p.id).filter((id) => ledgerUnit.has(id));
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const truth = ledgerUnit.get(ids[i]!) === ledgerUnit.get(ids[j]!);
        const pred = activeUnit.get(ids[i]!) === activeUnit.get(ids[j]!);
        if (truth && pred) tp += 1;
        else if (!truth && pred) fp += 1;
        else if (truth && !pred) fn += 1;
      }
    }
    const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
    console.log(
      `\n【promotion】分群质量（对比 golden audit_unit，只算能对上 golden 的 ${ids.length} 条账本命题）:`,
    );
    console.log(`  成对精确率 ${pct(tp, tp + fp)}（${tp}/${tp + fp}）　成对召回 ${pct(tp, tp + fn)}（${tp}/${tp + fn}）`);
    console.log(
      `  ${prec >= 0.8 ? "✅" : "⚠️"} 精确率低 = 错并（用户会漏看问题）；召回低 = 拆太碎（用户看到重复条目）`,
    );
    console.log(
      `  成本 $${pr.costUsd.toFixed(4)} / ${(pr.latencyMs / 1000).toFixed(1)}s` +
        `${pr.missed.length ? `　模型漏掉 ${pr.missed.length} 条（已单列）` : ""}`,
    );
  }

  console.log(`\n端到端评测 · ${golden.meta.name}`);
  console.log(`判定器   : ${provider.name}`);
  console.log(`账本     : ${ledger.length} 条命题（抽取 + 归并，非人工构造）`);
  console.log(`映射     : golden ${golden.propositions.length} 条 → 账本 ${toLedger.size} 条`);
  const uncovered = golden.propositions.filter((g) => !toLedger.has(g.id)).map((g) => g.id);
  if (uncovered.length) console.log(`          未覆盖：${uncovered.join(", ")}（相关样本一律算错）`);

  // 粒度切分诊断：一条 golden 命题（审计单元）被拆到了几条账本命题上。
  // 这个数字直接决定端到端准确率的上限 —— 拆成 k 条，采样时最多只有 1/k 的机会被指到「映射的那一条」。
  const splitHist = new Map<number, number>();
  for (const g of golden.propositions) {
    const n = ledger.filter((p) => pairScore(g.aliases, p).score > 0).length;
    splitHist.set(n, (splitHist.get(n) ?? 0) + 1);
  }
  console.log(
    `粒度切分 : ${[...splitHist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}条→${v}个命题`).join("　")}`,
  );
  console.log(`基线     : 人工账本 + JEV = 100%（48/48，3 轮稳定）\n`);

  const byKind = new Map<MentionKind, { ok: number; n: number }>();
  let ok = 0;
  let total = 0;
  let costUsd = 0;
  let latency = 0;
  let unanswerable = 0;
  let accepted = 0;
  let acceptedOk = 0;
  const wrong: string[] = [];

  /**
   * 失败分类 —— 决定下一步该修哪一层。
   *
   *   uncovered       gold 命题在账本里没有对应      → 抽取/归并真漏
   *   recall_miss     gold 账本命题不在召回候选里    → blocking 太窄
   *   judge_negative  判定选了 NEW / UNSURE          → 判定层缩了
   *   judge_same_unit 判定选了**同一审计单元**的另一条 → 粒度问题（promotion 的价值就在这里）
   *   judge_other     判定选了别的审计单元            → 真正的语义错误
   */
  const diag = { uncovered: 0, recall_miss: 0, judge_negative: 0, judge_same_unit: 0, judge_other: 0 };

  for (const s of golden.samples) {
    total += 1;
    // 负例样本的 gold 是字面量 "NEW" / "UNSURE"，不是命题 id —— 不能当「不可答」
    const special = s.gold.find((g) => g === "NEW" || g === "UNSURE");
    const goldIds = special ? [] : s.gold.map((g) => toLedger.get(g)).filter((x): x is string => Boolean(x));
    const expected = special ? [special] : goldIds;
    // ⚠️ 两侧必须用**同一个单元空间**：都走 activeUnit（账本命题 id → 单元 id）。
    // 早期版本这里拿 golden 的中文 audit_unit 当 truth、拿 promotion 的 U-xx 当预测，
    // 两个 id 空间永不相交，于是「同单元误判」恒为 0 —— 指标看起来「promotion 无用」，
    // 其实是度量写错了。
    const expectedUnits = new Set(
      goldIds.map((id) => activeUnit.get(id)).filter((u): u is string => Boolean(u)),
    );
    const stat = byKind.get(s.mention.kind) ?? { ok: 0, n: 0 };
    stat.n += 1;

    if (expected.length === 0) {
      unanswerable += 1;
      diag.uncovered += 1;
      byKind.set(s.mention.kind, stat);
      wrong.push(`${s.id}（gold 命题没被覆盖）`);
      continue;
    }

    const candidateIds = recall(s, ledger, sceneIndex, goldIds);
    const expectedInCands = expected.some((e) => candidateIds.includes(e));
    const byId = new Map(ledger.map((p) => [p.id, p]));
    const req: JudgmentRequest = {
      task: "bind_mention",
      mention: { ...s.mention, context: widenContext(s.mention.context, s.mention.scene, scenes) },
      candidates: candidateIds.map((id) => {
        const p = byId.get(id)!;
        return {
          id,
          canonical: p.canonical,
          keywords: p.aliases
            .filter((a) => (sceneIndex.get(a.firstSeen) ?? Number.MAX_SAFE_INTEGER) <= (sceneIndex.get(s.mention.scene) ?? 0))
            .map((a) => a.surface),
          type: "",
        };
      }),
      allowedChoices: [...candidateIds, "NEW", "UNSURE"],
    };

    try {
      const r = await provider.judge(req);
      costUsd += r.costUsd;
      latency += r.latencyMs;
      const hit = expected.includes(r.choice);
      if (hit) { ok += 1; stat.ok += 1; }
      else {
        if (!expectedInCands) diag.recall_miss += 1;
        else if (r.choice === "NEW" || r.choice === "UNSURE") diag.judge_negative += 1;
        else {
          const u = activeUnit.get(r.choice);
          if (u && expectedUnits.has(u)) diag.judge_same_unit += 1;
          else diag.judge_other += 1;
        }
        wrong.push(
          `${s.id} → ${r.choice}（期望 ${expected.join("/")}）` +
            `  conf=${r.confidence.toFixed(2)} margin=${marginOf(r).toFixed(2)}\n` +
            `       候选: ${req.candidates
              .map((c) => `${c.id}(${(c.keywords ?? []).length}kw)`)
              .join(" ")}`,
        );
      }
      if (r.choice !== "UNSURE" && r.confidence >= 0.8 && marginOf(r) >= 0.15) {
        accepted += 1;
        if (hit) acceptedOk += 1;
      }
      process.stdout.write(`  ${s.id} → ${r.choice}${hit ? "" : "  ✗"}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wrong.push(`${s.id} 错误：${message.slice(0, 80)}`);
      process.stdout.write(`  ${s.id} → 错误\n`);
    }
    byKind.set(s.mention.kind, stat);
  }

  console.log(`\n${"─".repeat(56)}`);
  console.log(`端到端准确率 : ${ok}/${total}  (${pct(ok, total)})`);
  console.log(`  其中不可答 : ${unanswerable} 条（gold 命题未被抽取层覆盖）`);
  console.log(`\n按 mention 类型:`);
  for (const k of ["explicit_noun", "repeated_surface", "vague_pronoun"] as MentionKind[]) {
    const st = byKind.get(k);
    if (st) console.log(`  ${k.padEnd(18)} ${String(st.ok).padStart(2)}/${String(st.n).padEnd(2)}  (${pct(st.ok, st.n)})`);
  }
  console.log(`\n级联接受集（choice≠UNSURE 且 conf≥0.8 且 margin≥0.15）:`);
  console.log(`  接受 ${accepted} 条，正确 ${acceptedOk} 条 → ${pct(acceptedOk, accepted)}`);
  console.log(`\n延迟合计 ${(latency / 1000).toFixed(1)}s（中位约 ${(latency / Math.max(1, total) / 1000).toFixed(2)}s）· 成本 $${costUsd.toFixed(4)}`);
  console.log(`基线对比 : 抽取账本 ${pct(ok, total)}（人工账本的同版本基线请看 run-eval.ts 的输出）`);

  // ── 失败分类：决定下一步该修哪一层 ──
  const unitLevel = ok + diag.judge_same_unit;
  console.log(`\n失败分类（共 ${total - ok} 条未命中）:`);
  console.log(`  uncovered       gold 命题在账本里无对应       ${String(diag.uncovered).padStart(2)}  → 抽取/归并真漏`);
  console.log(`  recall_miss     gold 账本命题不在召回候选      ${String(diag.recall_miss).padStart(2)}  → blocking 太窄`);
  console.log(`  judge_negative  判定选了 NEW / UNSURE         ${String(diag.judge_negative).padStart(2)}  → 判定层退缩`);
  console.log(`  judge_same_unit 判定选了同一审计单元的另一条   ${String(diag.judge_same_unit).padStart(2)}  → 粒度问题（promotion 的收益上限）`);
  console.log(`  judge_other     判定选了别的审计单元          ${String(diag.judge_other).padStart(2)}  → 真正的语义错误`);
  console.log(
    `\n审计单元级准确率（把同单元误判算对）: ${unitLevel}/${total}  (${pct(unitLevel, total)})` +
      `　相比命题级 +${unitLevel - ok} 条` +
      `${process.argv.includes("--promote") ? "　← 用的是 promotion 实际产出的分组" : "　← 用的是 golden audit_unit（收益上限）"}`,
  );

  if (wrong.length) {
    console.log(`\n判错/不可答的样本:`);
    for (const w of wrong) console.log(`  ${w}`);
  }
  console.log("");

  // ── 交给任务执行器（设了 RSI_RUN_DIR 才写文件；数字完全不变）──
  writeTaskResult(
    {
      task: "e2e",
      metrics: { ok, total, unanswerable, accepted, acceptedOk },
      extra: {
        pad: process.env.E2E_PAD ?? "id",
        diag,
        ledgerCache: CACHE,
        goldenSet: process.env.GOLDENSET ?? "goldenset.json",
      },
      evalCost: { usd: costUsd, seconds: 0 },
    },
    wrong.map((w) => JSON.stringify({ kind: "sample", verdict: "wrong", detail: w })),
  );
}

await main();

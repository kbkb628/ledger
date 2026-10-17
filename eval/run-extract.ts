/**
 * 抽取 + 归并 对拍 —— 用黄金集验收整条上游链路。
 *
 * ## 为什么这是最省力的端到端验证
 *
 * `eval/goldenset.json` 里已经有**同一个剧本**的 14 条命题 + 37 条别名 + `first_seen`，
 * 全部满足「原文真实出现」的纪律。所以可以直接对拍，**不需要新标注**。
 *
 * ## 两行对比：抽取直出 vs 抽取+归并
 *
 * 归并层是 v1 新加的（v0 把归并塞在抽取 prompt 里，结果模型按「说法相似」错并）。
 * 两行对比能直接回答「归并层值不值」：
 *   - **抽取直出**：每场的每条命题都算新命题 → 命题召回天然低（同一件事被拆成多条）
 *   - **抽取+归并**：跨场同一性交给 JEV 判定
 *
 * 用法：
 *   npm run eval:extract              # 用缓存对拍（不花钱）
 *   npm run eval:extract -- --fresh   # 重跑抽取 + 归并（约 $0.04 / 40s）
 *   npm run eval:extract -- --dump    # 打印账本全表
 *   npm run eval:extract -- --provider rule   # 归并层用零成本规则基线
 *
 * ## 匹配口径（这一版修过两次，见下）
 *
 * 1. golden 别名是**短片段**（「我回来了」），抽取产出是**原文整行**（「三年前。我回来了。」）
 *    → 必须用**双向包含**匹配（短串 ≥ 3 字）。
 * 2. 包含匹配会造出**枢纽假命中**：`那份东西` 同时出现在多条 golden 别名里，
 *    于是一条抽出命题「命中」四条 → 必须改成**一对一贪心指派**，
 *    按匹配片段总长度降序，每个 golden 与每个抽出命题各只用一次。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractScenes, type ExtractResult } from "../src/extraction/extractor.js";
import { mergeScenes, type MergeResult } from "../src/extraction/merge.js";
import { parseScenes } from "../src/extraction/script.js";
import type { DraftProposition, ReferenceKind } from "../src/extraction/types.js";
import { JevProvider } from "../src/judgment/jev-provider.js";
import { RuleProvider } from "../src/judgment/rule-provider.js";
import type { JudgmentProvider } from "../src/judgment/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.EXTRACT_CACHE ?? join(here, "out", "pipeline-v1.json");

interface GoldenAlias { surface: string; first_seen: string }
interface GoldenProposition { id: string; canonical: string; aliases: GoldenAlias[] }
interface GoldenSet { meta: { name: string }; propositions: GoldenProposition[] }
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

const norm = (s: string): string => s.replace(/[\s。，、！？：；「」（）·—…]/g, "");

/** 双向包含匹配，返回匹配片段长度（长度 = 具体程度） */
export function matchInfo(alias: string, surface: string): { kind: "exact" | "contains"; len: number } | null {
  const a = norm(alias);
  const b = norm(surface);
  if (!a || !b) return null;
  if (a === b) return { kind: "exact", len: a.length };
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 3 && long.includes(short) ? { kind: "contains", len: short.length } : null;
}

function pairScore(g: GoldenProposition, p: DraftProposition): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (const a of g.aliases) {
    let best = 0;
    for (const x of p.aliases) {
      const m = matchInfo(a.surface, x.surface);
      if (m) best = Math.max(best, m.len);
    }
    if (best > 0) { score += best; hits += 1; }
  }
  return { score, hits };
}

function diceBigram(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = norm(s);
    const out = new Set<string>();
    for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

const pct = (n: number, d: number): string => (d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1)}%`);

interface Metrics {
  covered: number;
  aliasHit: number;
  aliasExact: number;
  aliasTotal: number;
  firstSeenOk: number;
  matched: number;
  total: number;
}

/** 一对一贪心指派后计算指标（口径见文件头） */
function evaluate(
  golden: GoldenSet,
  props: DraftProposition[],
  log: boolean,
): {
  m: Metrics;
  missed: GoldenProposition[];
  hubs: Array<{ p: DraftProposition; gs: string[] }>;
  assigned: Map<string, DraftProposition>;
} {
  const pairs: Array<{ g: GoldenProposition; p: DraftProposition; score: number; hits: number }> = [];
  for (const g of golden.propositions) {
    for (const p of props) {
      const { score, hits } = pairScore(g, p);
      if (score > 0) pairs.push({ g, p, score, hits });
    }
  }
  pairs.sort((a, b) => b.score - a.score || b.hits - a.hits);

  const assigned = new Map<string, DraftProposition>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (assigned.has(pair.g.id) || used.has(pair.p.id)) continue;
    assigned.set(pair.g.id, pair.p);
    used.add(pair.p.id);
  }

  let aliasExact = 0;
  let aliasHit = 0;
  let firstSeenOk = 0;
  const missed: GoldenProposition[] = [];

  for (const g of golden.propositions) {
    const p = assigned.get(g.id);
    if (!p) {
      missed.push(g);
      if (log) console.log(`  ${g.id}  别名  0/${String(g.aliases.length).padEnd(2)}  → （无匹配）`);
      continue;
    }
    let exact = 0;
    let any = 0;
    for (const a of g.aliases) {
      let kind: "exact" | "contains" | null = null;
      let firstSeen = "";
      for (const x of p.aliases) {
        const m = matchInfo(a.surface, x.surface);
        if (m) {
          if (m.kind === "exact") { kind = "exact"; firstSeen = x.firstSeen; break; }
          kind = "contains";
          firstSeen = x.firstSeen;
        }
      }
      if (!kind) continue;
      any += 1;
      aliasHit += 1;
      if (kind === "exact") { exact += 1; aliasExact += 1; }
      if (firstSeen === a.first_seen) firstSeenOk += 1;
    }
    if (log) {
      console.log(
        `  ${g.id}  别名 ${String(any).padStart(2)}/${String(g.aliases.length).padEnd(2)}` +
          `（精确 ${exact}）  → ${p.id}   ${g.canonical.slice(0, 24)}`,
      );
    }
  }

  const hubs: Array<{ p: DraftProposition; gs: string[] }> = [];
  for (const p of props) {
    const gs = golden.propositions.filter((g) => pairScore(g, p).score > 0).map((g) => g.id);
    if (gs.length > 1) hubs.push({ p, gs });
  }

  return {
    m: {
      covered: assigned.size,
      aliasHit,
      aliasExact,
      aliasTotal: golden.propositions.reduce((a, p) => a + p.aliases.length, 0),
      firstSeenOk,
      matched: used.size,
      total: props.length,
    },
    missed,
    hubs,
    assigned,
  };
}

function printMetrics(label: string, m: Metrics, goldenN: number): void {
  console.log(`\n  【${label}】`);
  console.log(`    命题召回     : ${m.covered}/${goldenN}  (${pct(m.covered, goldenN)})`);
  console.log(
    `    别名召回     : ${m.aliasHit}/${m.aliasTotal}  (${pct(m.aliasHit, m.aliasTotal)})` +
      `　[精确 ${m.aliasExact}]`,
  );
  console.log(`    首见场景正确 : ${m.firstSeenOk}/${m.aliasHit}  (${pct(m.firstSeenOk, m.aliasHit)})`);
  console.log(`    抽出命题总数 : ${m.total}（命中 ${m.matched}，多余 ${m.total - m.matched}）`);
}

/** 抽取直出：每场的每条命题都算独立命题，不做任何跨场归并 */
function flatten(ex: ExtractResult): DraftProposition[] {
  const out: DraftProposition[] = [];
  let n = 1;
  for (const se of ex.scenes) {
    for (const d of se.propositions) {
      out.push({
        id: `R-${String(n++).padStart(3, "0")}`,
        canonical: d.canonical,
        aliases: d.surfaces.map((s) => ({ surface: s.text, firstSeen: se.scene, kind: s.kind })),
        scenes: [se.scene],
        agents: [...d.agents],
      });
    }
  }
  return out;
}

function pickProvider(): JudgmentProvider {
  const idx = process.argv.indexOf("--provider");
  const name = idx >= 0 ? process.argv[idx + 1] : (process.env.MERGE_PROVIDER ?? "jev");
  return name === "rule" ? new RuleProvider() : new JevProvider();
}

async function loadCache(): Promise<{ cache: CacheShape; cached: boolean }> {
  const fresh = process.argv.includes("--fresh");
  if (!fresh && existsSync(CACHE)) {
    return { cache: JSON.parse(readFileSync(CACHE, "utf8")) as CacheShape, cached: true };
  }

  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  console.log(`\n【第 0 层】场内抽取（${scenes.length} 场，逐场独立，不做跨场归并）`);
  const extracted = await extractScenes(scenes, { verbose: true });

  console.log(`\n【第 1 层】归并（blocking → JEV 判定）`);
  const provider = pickProvider();
  console.log(`  判定器：${provider.name}`);
  const merged = await mergeScenes(extracted.scenes, scenes, { provider, verbose: true });

  const cache: CacheShape = { extracted, merged };
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache, null, 2), "utf8");
  return { cache, cached: false };
}

async function main(): Promise<void> {
  loadEnv(join(here, "..", ".env"));
  const golden = JSON.parse(
    readFileSync(process.env.GOLDENSET ? resolve(process.env.GOLDENSET) : join(here, "goldenset.json"), "utf8"),
  ) as GoldenSet;

  console.log(`\n上游链路对拍 · ${golden.meta.name}`);
  console.log(`模型     : ${process.env.EXTRACT_MODEL ?? process.env.JUDGE_MODEL}`);
  console.log(
    `golden   : ${golden.propositions.length} 条命题 / ` +
      `${golden.propositions.reduce((a, p) => a + p.aliases.length, 0)} 条别名`,
  );

  const { cache, cached } = await loadCache();
  const { extracted, merged } = cache;

  const kinds = extracted.kindCounts as Record<ReferenceKind, number>;
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `抽取 : ${extracted.scenes.reduce((a, s) => a + s.propositions.length, 0)} 条场内命题 · ` +
      `${extracted.calls} 次调用 · ${(extracted.latencyMs / 1000).toFixed(1)}s · $${extracted.costUsd.toFixed(4)}` +
      `${cached ? "（缓存）" : ""}`,
  );
  console.log(`       指称类型 explicit ${kinds.explicit} / descriptive ${kinds.descriptive} / vague ${kinds.vague}`);
  console.log(`       原文可查拦截 ${extracted.rejectedSurfaces} 条${extracted.failures.length ? ` · 失败 ${extracted.failures.length} 场` : ""}`);
  console.log(
    `归并 : ${merged.propositions.length} 条账本命题 · ${merged.calls} 次判定 · ` +
      `${(merged.latencyMs / 1000).toFixed(1)}s · $${merged.costUsd.toFixed(4)} · UNSURE ${merged.unsure}`,
  );

  const raw = flatten(extracted);
  const rawEval = evaluate(golden, raw, false);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`逐条 golden 命题（归并后，一对一指派）:`);
  const mergedEval = evaluate(golden, merged.propositions, true);

  printMetrics("抽取直出（无归并）", rawEval.m, golden.propositions.length);
  printMetrics("抽取 + 归并（v1）", mergedEval.m, golden.propositions.length);

  // ── 别名未命中的三分类：这是决定下一步修什么的关键诊断 ──
  //
  //   absent    根本没抽出        → 抽取层召回问题（指令覆盖不全 / 粒度太粗略过）
  //   misplaced 抽出了但挂错命题  → 归并层问题（错并，或 golden 粒度更粗）
  //   fixed     挂对了            → 这条链路正确
  const absent: string[] = [];
  const misplaced: Array<{ g: string; alias: string; owners: string[] }> = [];
  for (const g of golden.propositions) {
    const p = mergedEval.assigned.get(g.id);
    for (const a of g.aliases) {
      if (p && p.aliases.some((x) => matchInfo(a.surface, x.surface))) continue;
      const owners = merged.propositions
        .filter((q) => q.aliases.some((x) => matchInfo(a.surface, x.surface)))
        .map((q) => q.id);
      if (owners.length) misplaced.push({ g: g.id, alias: a.surface, owners });
      else absent.push(`${g.id}「${a.surface}」`);
    }
  }

  const fixedN = mergedEval.m.aliasTotal - absent.length - misplaced.length;
  console.log(`\n别名去向三分类（共 ${mergedEval.m.aliasTotal} 条 golden 别名）:`);
  console.log(`  ✅ 挂对     : ${fixedN}  (${pct(fixedN, mergedEval.m.aliasTotal)})`);
  console.log(`  ⚠️ 挂错命题 : ${misplaced.length}  (${pct(misplaced.length, mergedEval.m.aliasTotal)})　→ 归并层 / 粒度不一致`);
  console.log(`  ❌ 根本没抽 : ${absent.length}  (${pct(absent.length, mergedEval.m.aliasTotal)})　→ 抽取层漏召`);

  if (misplaced.length) {
    console.log(`\n挂错命题的说法（原文抽到了，但被归到别的命题）:`);
    for (const m of misplaced) {
      const canon = merged.propositions.find((q) => q.id === m.owners[0])?.canonical ?? "";
      console.log(`  ${m.g}「${m.alias}」→ ${m.owners.join("/")}  ${canon.slice(0, 30)}`);
    }
  }
  if (absent.length) {
    console.log(`\n根本没抽出来的说法:`);
    console.log(`  ${absent.join("  ")}`);
  }

  if (mergedEval.hubs.length) {
    console.log(`\n⚠️ 枢纽命题（一条抽出命题同时匹配多条 golden —— 泛化说法造成）:`);
    for (const h of mergedEval.hubs) {
      const vague = h.p.aliases.filter((a) => a.kind === "vague").length;
      console.log(`  ${h.p.id} → ${h.gs.join(" / ")}   ${h.p.canonical.slice(0, 36)}`);
      console.log(`       说法：「${h.p.aliases.map((a) => a.surface).join("」「").slice(0, 80)}」（其中 vague ${vague}）`);
    }
  }

  if (mergedEval.missed.length) {
    console.log(`\n抽漏/未归并上的命题 + 最接近的抽出命题（粒度诊断）:`);
    for (const g of mergedEval.missed) {
      let best: { p: DraftProposition; score: number } | null = null;
      for (const p of merged.propositions) {
        const score = Math.max(
          diceBigram(g.canonical, p.canonical),
          ...g.aliases.map((a) => Math.max(...p.aliases.map((x) => diceBigram(a.surface, x.surface)))),
        );
        if (!best || score > best.score) best = { p, score };
      }
      console.log(`  ${g.id}  ${g.canonical.slice(0, 34)}`);
      console.log(`       golden 别名：${g.aliases.map((a) => `「${a.surface}」`).join(" ")}`);
      if (best) console.log(`       最近抽出：${best.p.id} (${best.score.toFixed(2)}) ${best.p.canonical.slice(0, 42)}`);
    }
  }

  // 归并决策分布 —— 看判定器是不是在「什么都并」
  const byReason = new Map<string, number>();
  for (const d of merged.decisions) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  console.log(`\n归并决策分布: ${[...byReason].map(([k, v]) => `${k}=${v}`).join("  ")}`);

  if (process.argv.includes("--dump")) {
    console.log(`\n${"─".repeat(60)}\n账本全表（归并后）:`);
    for (const p of merged.propositions) {
      console.log(`  ${p.id}  ${p.canonical}`);
      console.log(`       场景 ${p.scenes.join(",")}`);
      console.log(`       说法 ${p.aliases.map((a) => `${a.surface}[${a.kind[0]}]@${a.firstSeen}`).join(" | ")}`);
    }
    console.log(`\n归并决策:`);
    for (const d of merged.decisions) {
      console.log(`  ${d.scene}  ${d.choice.padEnd(6)} ${d.reason.padEnd(12)} ${d.canonical.slice(0, 40)}`);
    }
  }

  console.log("");
}

await main();

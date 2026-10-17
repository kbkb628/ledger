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
}
interface MustNotFlag { character: string; scene: string; surface: string; why: string }
interface LeaksFile {
  meta: { name: string };
  leaks: Annotation[];
  must_not_flag: MustNotFlag[];
}
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
    characterHint: chars.characters
      .filter((c) => c.aliases.length > 0)
      .map((c) => `${c.name} = ${c.aliases.join(" = ")}`)
      .join("\n"),
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
  const scenes = parseScenes(readFileSync(SCRIPT, "utf8"));
  const sceneOrder = new Map(scenes.map((s, i) => [s.id, i]));
  const cache = await loadCache();
  const ledger = cache.merged.propositions;

  const { facts } = buildKnowledge(ledger, cache.extracted.scenes);
  for (const d of defaultKnowledge(ledger, scenes)) {
    facts.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)", source: "default" });
  }
  const { usages } = buildUsages(ledger, scenes);

  // ── 把知识与使用一并提升到审计单元层，再跑 R1 ──
  //
  // 实测依据（test-plan.md §5.11）：同一事实被抽成三条命题（E-004/E-005/E-007），
  // 告知记录挂在一条、使用点在另一条，**按命题比对永远对不上**。
  // 知识是关于「那个秘密」的，使用也是，所以必须在单元层比对。
  const useUnits = !process.argv.includes("--no-units");
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
  console.log(`报出 : ${issues.length} 条问题`);

  // ── 匹配标注 ──
  const hitLeak = new Set<string>();
  const fps: typeof issues = [];
  const flaggedMustNot = new Map<string, string>();

  for (const iss of issues) {
    const surface = strip(iss.surface);
    const matched = ann.leaks.filter(
      (a) =>
        a.character === iss.character &&
        (a.exact_scene ? a.scene === iss.useScene : true) &&
        (surface.includes(strip(a.surface)) || strip(a.surface).includes(surface)),
    );
    if (matched.length > 0) {
      for (const m of matched) hitLeak.add(m.id);
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
  }

  const missed = ann.leaks.filter((a) => !hitLeak.has(a.id));
  const tp = hitLeak.size;
  const fp = fps.length;
  const fn = missed.length;

  // ── 逐条报 ──
  console.log(`\n${"═".repeat(62)}\n注入的泄漏 ${ann.leaks.length} 处:`);
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
    }
  }

  if (flaggedMustNot.size) {
    console.log(`\n⚠️ 被误报的「应当放过」台词（设计错误，不是精度问题）:`);
    for (const [k, scene] of flaggedMustNot) console.log(`  ${k} @${scene}`);
  }

  console.log(`\n${"─".repeat(62)}`);
  console.log(`精确率 ${pct(tp, tp + fp)}（真阳性 ${tp} / 报出 ${tp + fp}）`);
  console.log(`召回率 ${pct(tp, tp + fn)}（抓到 ${tp} / 注入 ${tp + fn}）`);
  console.log(`误报   ${fp} 条`);

  if (fps.length) {
    console.log(`\n误报明细:`);
    for (const f of fps) {
      console.log(`  ${f.useScene} ${f.character}「${f.surface}」→ ${f.canonical.slice(0, 30)}`);
    }
  }

  console.log(`\n抽取成本 $${cache.extracted.costUsd.toFixed(4)} + 归并 $${cache.merged.costUsd.toFixed(4)}\n`);
}

await main();

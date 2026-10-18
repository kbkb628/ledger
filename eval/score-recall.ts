/**
 * **确定性**的召回层指标 —— 不叫判官、不含采样噪声。
 *
 * ## 为什么要有它
 *
 * 幻影集上连续两轮实验（回合 51/53）都卡在同一处：效应是「+5~7 条、p≈0.07~0.18」，
 * 因为整条链（召回 → 判官挂载 → 泄漏报告）被压成一个「抓到/没抓到」的布尔值，
 * 判官的采样抖动把召回层的真实变化盖住了。按 28%→38% 的效应量反算，要 150 对以上才够功效。
 *
 * 但这条链的前半段是**纯算法**：如果某条 draft 的候选表里根本没有「它该挂上去的那条命题」，
 * 那后面的判官再准也没用。这一半可以精确测量，而且 60 对就够。
 *
 * ## 三个读数
 *
 * | 指标 | 含义 | 期望 |
 * |---|---|---|
 * | `候选召回` | 该挂的目标命题是否出现在这条 draft 的候选表里 | 越高越好（这是上限） |
 * | `挂载率` | 候选召回后，判官有没有真的挂上去 | 越高越好（这是利用率） |
 * | `漏在召回` | 候选表里没有目标 → 判官没机会 | 越低越好（这是要修的量） |
 *
 * 用法：`R1_MERGE_TRACE=runs/trace.jsonl` 跑一次 run-r1，然后
 * `npx tsx eval/score-recall.ts runs/trace.jsonl eval/leaks-phantom.json`
 */
import { readFileSync } from "node:fs";

const strip = (s: string): string => s.replace(/\s+/g, "");

interface TraceRow {
  scene: string;
  canonical: string;
  surfaces: string[];
  candidates: string[];
  choice: string;
  createdId?: string | null;
  reason: string;
}

interface Leak {
  id: string;
  variant: "phantom" | "anchored";
  surface: string;
  established: string;
  scene: string;
  character: string;
}

const tracePath = process.argv[2] ?? "runs/trace.jsonl";
const leaksPath = process.argv[3] ?? "eval/leaks-phantom.json";

const rows: TraceRow[] = readFileSync(tracePath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as TraceRow);
const leaks = (JSON.parse(readFileSync(leaksPath, "utf8")) as { leaks: Leak[] }).leaks;

/** 一个 draft 的候选表里是否出现过 `id` */
const recalls = (r: TraceRow, id: string): boolean => r.candidates.includes(id);

/** 找到「某段说法」对应的 trace 行：surfaces 里有包含它的那条（取第一条） */
function rowOf(surface: string, scene?: string): TraceRow | undefined {
  const needle = strip(surface);
  return rows.find(
    (r) => (!scene || r.scene === scene) && r.surfaces.some((s) => strip(s).includes(needle) || needle.includes(strip(s))),
  );
}

/**
 * 一条事实的「目标命题」= 它在**确立场景**里长出来的那条命题。
 * 从 trace 里取：确立场景的那条 draft，若挂上了就是 choice，若是新建就是 createdId。
 */
function targetOf(fact: Leak, anchor: Leak): { id: string | null; how: string } {
  const atEstab = rowOf(anchor.surface, fact.established) ?? rowOf(anchor.surface);
  if (!atEstab) return { id: null, how: "确立场景的 draft 不在 trace 里" };
  if (atEstab.createdId) return { id: atEstab.createdId, how: "确立时新建" };
  if (/^E-\d+$/.test(atEstab.choice)) return { id: atEstab.choice, how: "确立时挂到既有命题" };
  return { id: null, how: "确立时判为 NEW 但没记录 id" };
}

const byFact = new Map<string, { phantom?: Leak; anchored?: Leak }>();
for (const l of leaks) {
  const fact = l.id.slice(0, 4);
  const slot = byFact.get(fact) ?? {};
  slot[l.variant] = l;
  byFact.set(fact, slot);
}

const tally = {
  phantom: { n: 0, extracted: 0, recalled: 0, attached: 0 },
  anchored: { n: 0, extracted: 0, recalled: 0, attached: 0 },
};
const detail: string[] = [];
const missedExtract: string[] = [];
let noTarget = 0;

for (const [fact, slot] of [...byFact.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!slot.phantom || !slot.anchored) continue;
  const t = targetOf(slot.phantom, slot.anchored);
  if (!t.id) {
    noTarget += 1;
    detail.push(`${fact} 目标未解析（${t.how}）`);
    continue;
  }
  for (const variant of ["phantom", "anchored"] as const) {
    const leak = slot[variant]!;
    const bucket = tally[variant];
    bucket.n += 1;
    const row = rowOf(leak.surface, leak.scene);
    // ① 抽取层：这句台词有没有被抽成 draft —— 没有就根本谈不上召回
    if (!row) {
      if (variant === "phantom") missedExtract.push(leak.id);
      continue;
    }
    bucket.extracted += 1;
    // ② 候选召回层：该挂的目标命题在不在候选表里
    const recalled = recalls(row, t.id);
    if (recalled) bucket.recalled += 1;
    // ③ 挂载层：判官有没有真的挂上去
    if (row.choice === t.id) bucket.attached += 1;
    if (variant === "phantom" && !recalled) {
      detail.push(`❌ ${leak.id} 候选表里没有 ${t.id}（有 ${row.candidates.length} 条别的候选）→ ${row.choice}`);
    }
  }
}

const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
console.log(`\n确定性召回层读数 · ${tracePath}`);
console.log(`  draft 轨迹 ${rows.length} 条 · 事实 ${byFact.size} 个 · 目标未解析 ${noTarget} 个\n`);
for (const v of ["phantom", "anchored"] as const) {
  const t = tally[v];
  console.log(
    `  ${v.padEnd(9)} ①抽取覆盖 ${String(t.extracted).padStart(2)}/${t.n} = ${pct(t.extracted, t.n).padStart(6)}` +
      `  ②候选召回 ${String(t.recalled).padStart(2)}/${t.extracted} = ${pct(t.recalled, t.extracted).padStart(6)}` +
      `  ③挂载 ${String(t.attached).padStart(2)}/${t.extracted} = ${pct(t.attached, t.extracted).padStart(6)}`,
  );
}
const missRec = tally.phantom.extracted - tally.phantom.recalled;
console.log(`\n  phantom 丢在哪一层：抽取未覆盖 ${missedExtract.length} 条 · 候选未召回 ${missRec} 条 · 召回了没挂上 ${tally.phantom.recalled - tally.phantom.attached} 条`);
if (missedExtract.length) console.log("  抽取未覆盖：" + missedExtract.join(","));
if (detail.length) console.log("\n" + detail.slice(0, 12).join("\n"));

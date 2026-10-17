/**
 * 两个评测结果的配对比较 —— 防止「2 条样本的抖动被当成结论」。
 *
 * ## 为什么必须有（已经因此写错了两条结论）
 *
 * 1. `rsi-log.md` 写「DeepSeek 95.8% > JEV 91.7%」。两者只差 2 条样本，
 *    McNemar 精确检验 p = 0.50 —— **从来没有依据**。
 * 2. `test-plan.md` P0-1 写「存在排序敏感性（reversed −4.2pp）」。同样是 2 条样本。
 *
 * 共同的错误：把点估计的差当结论，既不做配对检验，也不看区间。
 * 48 样本的分辨力约 12pp；要比较配置差异，得 n≈150–267。
 *
 * ## 方法
 *
 * - **McNemar 精确检验**：同一批样本上两个配置的差异，只看**不一致对**（A 对 B 错 / A 错 B 对）。
 *   这是配对二分数据的标准检验；用精确二项而非卡方近似，因为不一致对通常很少（n<25）。
 * - **Wilson 区间**：每个配置各自的准确率区间。
 * - **判定规则**：不一致对 < 6 时不下结论；p ≥ 0.05 时写「无差异」。
 *   参考 inspect_evals 文档的「差异 <~2×stderr 视为噪声」，与之同向。
 *
 * 用法：
 *   npx tsx eval/compare.ts runs/a runs/b          # 比较两个 run 目录
 *   npx tsx eval/compare.ts runs/a --judge         # 只比 judge 任务
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatRate, wilson } from "../src/rsi/metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** 精确二项检验（双侧），用于 McNemar 的少量不一致对 */
function binomTwoSided(k: number, n: number, p = 0.5): number {
  if (n === 0) return 1;
  const logC = (nn: number, kk: number): number => {
    let s = 0;
    for (let i = 1; i <= kk; i++) s += Math.log(nn - kk + i) - Math.log(i);
    return s;
  };
  const pmf = (x: number): number => Math.exp(logC(n, x) + x * Math.log(p) + (n - x) * Math.log(1 - p));
  const tail = (from: number, to: number): number => {
    let s = 0;
    for (let x = from; x <= to; x++) s += pmf(x);
    return s;
  };
  const lower = tail(0, Math.min(k, n));
  const upper = tail(k, n);
  return Math.min(1, 2 * Math.min(lower, upper));
}

interface TraceRow {
  id?: string;
  detail?: string;
  verdict?: string;
}

/** 从 run 目录读 trace.jsonl，取出该任务每个样本的「是否正确」 */
function readOutcomes(runDir: string, task: string): Map<string, boolean> | null {
  const p = join(runDir, "trace.jsonl");
  if (!existsSync(p)) return null;
  const rows = readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.task === task);

  const out = new Map<string, boolean>();
  for (const r of rows) {
    // judge/e2e 的 trace 只记**错误**样本：出现即 false，其余靠 result.json 的 ok 数补齐
    const id = String(r.id ?? r.detail ?? "").slice(0, 60);
    if (id) out.set(id, false);
  }
  return out;
}

function summarize(dir: string, task: string): { ok: number; total: number; wrong: Set<string> } | null {
  const rp = join(dir, `${task}.result.json`);
  if (!existsSync(rp)) return null;
  const art = JSON.parse(readFileSync(rp, "utf8")) as { metrics?: Record<string, number> };
  const m = art.metrics ?? {};
  const ok = Number(m.ok ?? m.tp ?? 0);
  const total = Number(m.total ?? (Number(m.tp ?? 0) + Number(m.fp ?? 0) + Number(m.fn ?? 0)));
  const wrong = readOutcomes(dir, task) ?? new Map<string, boolean>();
  return { ok, total, wrong: new Set([...wrong.keys()]) };
}

function main(): void {
  const a = process.argv[2];
  const b = process.argv[3];
  if (!a || !b) throw new Error("用法：compare.ts <runA> <runB> [--judge|--e2e|--r1]");
  const only = process.argv.includes("--judge") ? "judge" : process.argv.includes("--e2e") ? "e2e" : process.argv.includes("--r1") ? "r1" : null;
  const dir = (d: string): string => (d.includes("/") || d.includes("\\") ? join(root, d) : join(root, "runs", d));

  const tasks = only ? [only] : ["judge", "e2e", "r1"];
  for (const task of tasks) {
    const A = summarize(dir(a), task);
    const B = summarize(dir(b), task);
    if (!A || !B) continue;

    console.log(`\n=== ${task} ===`);
    console.log(`  A ${a}: ${formatRate(A.ok, A.total)}（95% Wilson）`);
    console.log(`  B ${b}: ${formatRate(B.ok, B.total)}（95% Wilson）`);

    // 只有两边都知道「哪些样本错」时才能配对
    const ids = new Set([...A.wrong, ...B.wrong]);
    if (ids.size === 0) {
      console.log(`  两侧都无错误样本，无法配对（或 trace 为空）`);
      continue;
    }
    let aOnly = 0;
    let bOnly = 0;
    for (const id of ids) {
      const inA = A.wrong.has(id);
      const inB = B.wrong.has(id);
      if (inA && !inB) aOnly += 1; // A 错 B 对
      else if (!inA && inB) bOnly += 1;
    }
    const discordant = aOnly + bOnly;
    const p = binomTwoSided(Math.min(aOnly, bOnly), discordant);
    const [la, ha] = wilson(A.ok, A.total);
    const [lb, hb] = wilson(B.ok, B.total);
    const overlap = la <= hb && lb <= ha;

    console.log(`  不一致对：A错B对 ${aOnly} / A对B错 ${bOnly}　合计 ${discordant}`);
    console.log(`  McNemar 精确 p = ${p.toFixed(3)}`);
    console.log(`  区间${overlap ? "重叠" : "不重叠"}（Δ点估计 ${(((B.ok - A.ok) / A.total) * 100).toFixed(1)}pp）`);

    if (discordant < 6) {
      console.log(`  ⇒ **不下结论**：不一致对 < 6，任何差异都在噪声内`);
    } else if (p >= 0.05) {
      console.log(`  ⇒ **无差异**（p ≥ 0.05）`);
    } else {
      console.log(`  ⇒ 差异显著（p < 0.05），方向：${B.ok > A.ok ? "B 更好" : "A 更好"}`);
    }
    console.log(`  提示：48 样本分辨力约 12pp；要比较配置差异，样本量需 n≈150–267。`);
  }
  console.log("");
}

main();

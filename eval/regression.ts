/**
 * 联合回归 —— 上游改动（抽取/归并/promotion）的唯一裁决入口。
 *
 * ## 为什么不能只跑一次
 *
 * 冻结上游时 e2e **3 次零抖动**；但**跨抽取的抖动是 ±6 条**（实测见 rsi-protocol 第 9 回合）。
 * 所以「上游改动 → 重抽一次 → 比 e2e」这条路**本来就测不出 4 条的差异**。
 *
 * 结论：上游改动必须跑 **K≥3 次重抽取**，用**中位数**裁决；单次无裁决权。
 *
 * ## 为什么不给每次小改动都跑它
 *
 * 一轮 K=3 要约 4–5 分钟、$0.2。所以分工是：
 *   - **R1 层改动**（只动开关）→ 冻结基线 + `--reuse`，秒级、零抖动
 *   - **上游改动** → 走这里，K 次中位数
 *
 * ## 用法
 *
 *   npm run regression                 # 跑 K=3，与 eval/baseline/regression.json 比对
 *   npm run regression -- --k 5        # 更稳，更贵
 *   npm run regression -- --save       # 通过后把结果存为新基线
 *   npm run regression -- --force-save # 明知退了也要覆盖基线（慎用，会洗掉红线）
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeMetrics, formatMetrics, type Metrics } from "../src/rsi/metrics.js";
import { verify as testsetVerify } from "../src/rsi/testset.js";
import { versionFingerprint } from "../src/rsi/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BASELINE = join(root, "eval", "baseline", "regression.json");

/** 红线：判定层或端到端中位数退到这个条数即判失败 */
const RED_LINE_SAMPLES = 2;

/**
 * **每个任务的测量配置必须钉死在这里。**
 *
 * 踩过的坑（第 10 回合）：回归脚本没钉配置，于是 judge 用默认
 * `canonical + line + goldenset v2` 跑出 23/48 —— 那是**最早的 v0 基线**，
 * 不是 91.7% 那个已验证配置。基线因此是错的，而且看上去像"崩了"。
 *
 * 教训：**测量配置是测量的一部分**。它不进版本指纹、不进基线，
 * 就会出现「数字变了，但不知道是模型变了还是配置变了」。
 */
const TASK_ENV: Record<string, Record<string, string>> = {
  judge: {
    GOLDENSET: "eval/goldenset-v3.json",
    JEV_CRITERIA_MODE: "keywords",
    EVAL_CONTEXT: "neighbors",
    EVAL_ORDER: "recall",
  },
  e2e: {
    GOLDENSET: "eval/goldenset-v3.json",
    E2E_PAD: "id",
  },
  r1: {
    R1_SCRIPT: "eval/script-leak.md",
  },
  /**
   * 真实剧本零标注精确率（《茶馆》72 场）。
   * 用**冻结的流水线缓存**，只重跑 R1 层 —— 确定性、零成本、分布真实。
   * 注意：它捕捉的是 R1 层改动；上游改动要另跑 `--real-fresh` 重新抽取。
   */
  audit: {
    AUDIT_SCRIPT: "eval/script-chaguan.md",
    AUDIT_CACHE: "eval/baseline/pipeline-chaguan.json",
  },
};

interface Trial {
  e2e: { ok: number; total: number };
  r1: { tp: number; fp: number; fn: number };
}

interface RegressionBaseline {
  at: string;
  k: number;
  config: Record<string, Record<string, string>>;
  version: { hash: string; commit: string; promptHash: string };
  judge: { ok: number; total: number };
  e2e: { median: number; total: number; trials: number[] };
  r1: { trial: { tp: number; fp: number; fn: number }; cost: number; trials: number[] };
  /** 真实剧本误报数（零标注精确率） */
  real: { issues: number; usages: number };
}

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function run(script: string, extra: string[], runDir: string, taskEnv: Record<string, string>): number {
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [tsxCli, script, ...extra], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"], // 接管 stdout 只为压噪音；错误仍可见
    env: { ...process.env, ...taskEnv, RSI_RUN_DIR: runDir },
    encoding: "utf8",
  });
  return res.status ?? 1;
}

function readResult(runDir: string, task: string): Record<string, unknown> | null {
  const p = join(runDir, `${task}.result.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

function main(): void {
  loadEnv(join(root, ".env"));

  const k = process.argv.includes("--k") ? Number(process.argv[process.argv.indexOf("--k") + 1]) : 3;
  const save = process.argv.includes("--save") || process.argv.includes("--force-save");
  const forceSave = process.argv.includes("--force-save");
  if (!Number.isFinite(k) || k < 1) throw new Error("--k 必须是正整数");

  // ── 测试集版本校验（规则 R1）：内容变了却没升版本 → 数字不可信，直接拒绝跑 ──
  const drift = testsetVerify().filter((r) => !r.ok);
  if (drift.length > 0) {
    console.log(`\n❌ 测试集内容与注册版本不一致（内容改了但没升版本）：`);
    for (const d of drift) console.log(`   ${d.id}@${d.version}  登记 ${d.registered}  实际 ${d.actual}`);
    console.log(`\n先执行：npm run testset -- record <id> --files ... --changes "..."\n`);
    process.exitCode = 1;
    return;
  }

  const version = versionFingerprint(root);
  const base = join(root, "runs", `regression-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  mkdirSync(base, { recursive: true });

  console.log(`\n${"═".repeat(66)}`);
  console.log(`联合回归 · K=${k} · 版本 ${version.hash}（commit ${version.commit} / prompt ${version.promptHash}）`);
  console.log(`基线文件 ${existsSync(BASELINE) ? BASELINE : "（无，首次运行）"}`);
  console.log(`${"═".repeat(66)}`);

  // ── 判定层：只用人工账本，与抽取无关，跑一次即可 ──
  console.log(`\n[1/${k + 1}] judge`);
  const judgeDir = join(base, "judge");
  mkdirSync(judgeDir, { recursive: true });
  run("eval/run-eval.ts", ["--provider", "jev"], judgeDir, TASK_ENV.judge!);
  const judgeArt = readResult(judgeDir, "judge");
  const judgeOk = Number((judgeArt?.metrics as Record<string, number> | undefined)?.ok ?? 0);
  const judgeTotal = Number((judgeArt?.metrics as Record<string, number> | undefined)?.total ?? 0);
  console.log(`  judge ${judgeOk}/${judgeTotal}`);

  // ── 真实剧本：冻结上游，只跑 R1 层（确定性）──
  console.log(`\n[real] audit on 茶馆（冻结缓存）`);
  const realDir = join(base, "real");
  mkdirSync(realDir, { recursive: true });
  run("eval/run-audit.ts", [], realDir, TASK_ENV.audit!);
  const realArt = readResult(realDir, "audit");
  const realMetrics = (realArt?.metrics ?? {}) as Record<string, number>;
  const realIssues = realMetrics.issues ?? 0;
  const realUsages = realMetrics.usages ?? 0;
  console.log(`  real ${realIssues} 条报出 / ${realUsages} 使用点`);

  // ── K 次重抽取 → 每次 e2e + r1 ──
  const trials: Trial[] = [];
  for (let i = 1; i <= k; i++) {
    const dir = join(base, `trial-${i}`);
    mkdirSync(dir, { recursive: true });
    console.log(`\n[${i + 1}/${k + 1}] trial ${i}：重抽golden → e2e → 重抽leak → r1`);
    run("eval/run-extract.ts", ["--fresh"], dir, TASK_ENV.e2e!);
    run("eval/run-e2e.ts", [], dir, TASK_ENV.e2e!);
    run("eval/run-r1.ts", ["--fresh"], dir, TASK_ENV.r1!);

    const e2e = readResult(dir, "e2e");
    const r1 = readResult(dir, "r1");
    const em = (e2e?.metrics ?? {}) as Record<string, number>;
    const rm = (r1?.metrics ?? {}) as Record<string, number>;
    trials.push({
      e2e: { ok: em.ok ?? 0, total: em.total ?? 48 },
      r1: { tp: rm.tp ?? 0, fp: rm.fp ?? 0, fn: rm.fn ?? 0 },
    });
    console.log(`  e2e ${em.ok}/${em.total}　r1 P/R = ${formatMetrics(computeMetrics(rm.tp ?? 0, rm.fp ?? 0, rm.fn ?? 0))}`);
  }

  // ── 聚合：中位数 ──
  const e2eOk = trials.map((t) => t.e2e.ok);
  const r1Costs = trials.map((t) => computeMetrics(t.r1.tp, t.r1.fp, t.r1.fn).cost);
  const e2eMedian = median(e2eOk);
  const r1MedianCost = median(r1Costs);
  const r1MedianTrial = trials.find((t) => computeMetrics(t.r1.tp, t.r1.fp, t.r1.fn).cost === r1MedianCost)!.r1;
  const r1Metrics: Metrics = computeMetrics(r1MedianTrial.tp, r1MedianTrial.fp, r1MedianTrial.fn);

  console.log(`\n${"═".repeat(66)}\n汇总（K=${k}，取中位数）`);
  console.log(`  judge ${judgeOk}/${judgeTotal}`);
  console.log(`  e2e   ${e2eMedian}/${trials[0]?.e2e.total ?? 48}　（各次 ${e2eOk.join(", ")}）`);
  console.log(`  r1    ${formatMetrics(r1Metrics)}　（各次 cost ${r1Costs.join(", ")}）`);
  console.log(`  real  ${realIssues} 条报出 / ${realUsages} 使用点`);

  const current: RegressionBaseline = {
    at: new Date().toISOString(),
    k,
    config: TASK_ENV,
    version: { hash: version.hash, commit: version.commit, promptHash: version.promptHash },
    judge: { ok: judgeOk, total: judgeTotal },
    e2e: { median: e2eMedian, total: trials[0]?.e2e.total ?? 48, trials: e2eOk },
    r1: { trial: r1MedianTrial, cost: r1MedianCost, trials: r1Costs },
    real: { issues: realIssues, usages: realUsages },
  };

  // ── 与基线比对 ──
  const before = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as RegressionBaseline) : null;
  const regressions: string[] = [];

  if (!before) {
    console.log(`\n没有历史基线 —— 这是一次基准测定。`);
  } else {
    const dJudge = judgeOk - before.judge.ok;
    const dE2e = e2eMedian - before.e2e.median;
    const dR1 = r1MedianCost - before.r1.cost;
    const arrow = (d: number): string => (d > 0 ? `↑+${d}` : d < 0 ? `↓${d}` : "=");
    console.log(`\n与基线（${before.at.slice(0, 19)}，K=${before.k}）比对：`);
    console.log(`  judge ${arrow(dJudge)}　（${before.judge.ok} → ${judgeOk}）`);
    console.log(`  e2e   ${arrow(dE2e)}　（${before.e2e.median} → ${e2eMedian}）`);
    console.log(`  r1    cost ${arrow(dR1)}　（${before.r1.cost} → ${r1MedianCost}）`);

    if (dJudge <= -RED_LINE_SAMPLES) regressions.push(`判定层退 ${-dJudge} 条（红线 ≥${RED_LINE_SAMPLES}）`);
    if (dE2e <= -RED_LINE_SAMPLES) regressions.push(`端到端退 ${-dE2e} 条（红线 ≥${RED_LINE_SAMPLES}）`);
    if (dR1 > 0) regressions.push(`R1 cost 上升 ${dR1}`);
    // 旧基线可能没有 real 字段（本项是回合 15 才加的）→ 首次只记录，不判红线
    if (before.real) {
      const dReal = realIssues - before.real.issues;
      console.log(`  real  ${arrow(dReal)}　（${before.real.issues} → ${realIssues}）`);
      if (dReal >= RED_LINE_SAMPLES) regressions.push(`真实剧本误报增加 ${dReal} 条（红线 ≥${RED_LINE_SAMPLES}）`);
    } else {
      console.log(`  real  （旧基线无此项，本次记为初始值 ${realIssues}）`);
    }
  }

  if (regressions.length) {
    console.log(`\n❌ 触发红线：`);
    for (const r of regressions) console.log(`   · ${r}`);
    if (!forceSave) {
      console.log(`\n结论：**必须回退**（改用开关默认值或 git revert）。未覆盖基线。\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n⚠️ --force-save 已指定，仍覆盖基线（这会洗掉红线，慎用）`);
  } else if (before) {
    console.log(`\n✅ 未触发红线。`);
  }

  if (save || !before) {
    writeFileSync(BASELINE, JSON.stringify(current, null, 2), "utf8");
    console.log(`基线已写入 ${BASELINE}`);
  } else {
    console.log(`（未加 --save，基线未更新）`);
  }
  console.log(`各次产物在 ${base}\n`);
}

main();

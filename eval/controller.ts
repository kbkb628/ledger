/**
 * 搜索控制器 —— RSI 五组件的最后一块。
 *
 * ## 它自动化的是什么
 *
 * 在此之前，「提议 → 执行 → 裁决」每一步都要人手工串：
 * 看分桶 → 挑一个改法 → 手改环境变量跑一遍 → 读数字 → 判断。
 * 控制器把这条链跑完，**人只做最终批准**（翻默认值）。
 *
 * ## 它只自动执行「开关型」候选
 *
 * 这是刻意的范围限定：
 *   - **开关型**（`requiresNewBaseline: false`）→ 冻结基线 + `--reuse`，秒级、零抖动，可无人值守
 *   - **上游型**（改抽取/归并代码）→ 控制器**无权自己改代码**，只输出「需人工实现」与方向
 *
 * 所以控制器不是"自动改代码"，而是"把开关的搜索空间穷举掉"——
 * 那恰好就是提议器 `variants` 字段存在的意义（同一桶的多个参数档）。
 *
 * ## 预算与停止条件
 *
 *   `--max-candidates N`  最多试几个候选（默认 3）
 *   `--max-usd X`         评测花费上限（开关型候选几乎为 0，主要是防上游型误入）
 *   停止：候选耗尽 / 预算耗尽 / 找到一个 cost 严格更低的候选
 *
 * ## 三个闸都由 `judgeCandidate` 统一裁决，控制器不复刻判断逻辑
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyze, type TraceEntry } from "../src/rsi/buckets.js";
import { createExperiment, currentFrontier, loadExperiment, type ExperimentRecord } from "../src/rsi/experiments.js";
import { computeMetrics, formatMetrics, judgeCandidate, type Metrics } from "../src/rsi/metrics.js";
import { propose, renderProposal } from "../src/rsi/proposer.js";
import { versionFingerprint } from "../src/rsi/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const LEAK_BASELINE = join(root, "eval", "baseline", "pipeline-leak-v3.json");

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface CandidateOutcome {
  variant: Record<string, string>;
  metrics: Metrics;
  verdict: string;
  reason: string;
  experimentId: string;
}

function main(): void {
  loadEnv(join(root, ".env"));

  const fromRun = arg("from-run");
  if (!fromRun) throw new Error("用法：controller --from-run <runId> [--bucket <name>] [--max-candidates 3] [--dry]");
  const maxCandidates = Number(arg("max-candidates") ?? 3);
  const dry = process.argv.includes("--dry");

  // ── 1. 从执行轨迹里看当前最大的洞 ──
  const tracePath = join(root, "runs", fromRun, "trace.jsonl");
  if (!existsSync(tracePath)) throw new Error(`没有轨迹文件 ${tracePath}`);
  const entries = readFileSync(tracePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEntry)
    .filter((e) => e.kind === "annotation" || e.kind === "issue");
  const report = analyze(entries);

  console.log(`\n${"═".repeat(66)}`);
  console.log(`搜索控制器 · 轨迹 ${fromRun}（失败 ${report.classified.length} 条）`);
  console.log(`分桶：${report.histogram.map((h) => `${h.bucket}=${h.count}`).join("  ")}`);
  console.log(`${"═".repeat(66)}`);

  const bucket = (arg("bucket") ?? report.top?.bucket) as keyof typeof import("../src/rsi/proposer.js").BUCKET_FIXES;
  if (!bucket) throw new Error("没有可分桶的失败，或指定了 --bucket");
  console.log(`\n目标桶：${bucket}${arg("bucket") ? "（人工指定）" : "（当前最大）"}`);
  console.log(`${renderProposal(bucket, report.histogram.find((h) => h.bucket === bucket)?.count ?? 0)}\n`);

  const fix = propose(bucket);
  if (!fix) {
    console.log(`控制器：该桶没有已知改法，需要人工分析。停止。\n`);
    return;
  }
  if (fix.requiresNewBaseline) {
    console.log(
      `控制器：该桶的候选改法属于**上游改动**（${fix.switch}），控制器无权自己改代码。\n` +
        `  需人工实现后跑：npm run regression -- --k 3\n` +
        `  停止（不做无效搜索）。\n`,
    );
    return;
  }

  // ── 2. 父版本 ──
  const parent = currentFrontier(root);
  if (!parent?.result.dev) throw new Error("找不到可比的父版本（前沿记录缺 dev 指标）");
  console.log(`父版本：${parent.id}（${formatMetrics(parent.result.dev)}）`);

  if (dry) {
    console.log(`\n[dry] 将要试的 ${Math.min(maxCandidates, fix.variants.length)} 个候选：`);
    for (const v of fix.variants.slice(0, maxCandidates)) {
      console.log(`  ${fix.switch}=1 ${Object.entries(v).map(([k, x]) => `${k}=${x}`).join(" ")}`);
    }
    console.log(`\n（--dry，未执行）\n`);
    return;
  }

  // ── 3. 逐个候选：执行 + 裁决 ──
  const version = versionFingerprint(root);
  const outcomes: CandidateOutcome[] = [];
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  let spentUsd = 0;

  for (const [i, variant] of fix.variants.slice(0, maxCandidates).entries()) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, variant, { [fix.switch]: "1" });
    const dir = join(root, "runs", `candidate-${fromRun}-${i + 1}`);
    mkdirSync(dir, { recursive: true });

    console.log(`\n▶ 候选 ${i + 1}/${Math.min(maxCandidates, fix.variants.length)}：${fix.switch}=1 ${JSON.stringify(variant)}`);
    const res = spawnSync(process.execPath, [tsxCli, "eval/run-r1.ts", "--reuse"], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...env, R1_CACHE: LEAK_BASELINE, RSI_RUN_DIR: dir },
      encoding: "utf8",
    });
    if (res.status !== 0) {
      console.log(`  执行失败（退出码 ${res.status}），跳过`);
      continue;
    }

    const art = JSON.parse(readFileSync(join(dir, "r1.result.json"), "utf8")) as {
      metrics: Record<string, number>;
      evalCost?: { usd: number };
    };
    const m = computeMetrics(art.metrics.tp!, art.metrics.fp!, art.metrics.fn!);
    spentUsd += art.evalCost?.usd ?? 0;

    const { verdict, reason } = judgeCandidate(m, parent.result.dev, null, {
      candidate: { version: "v3", size: 10 },
      parent: parent.result.devSet,
    });

    const rec: ExperimentRecord = createExperiment(
      {
        parent: parent.id,
        version,
        change: {
          bucket: bucket as ExperimentRecord["change"]["bucket"],
          hypothesis: fix.hypothesis,
          file: fix.file,
          switch: fix.switch,
          params: variant,
        },
        result: { dev: m, devSet: { version: "v3", size: 10 } },
        evalCost: { usd: art.evalCost?.usd ?? 0, seconds: 0 },
        status: verdict === "reject" ? "rejected" : "candidate",
        note: `控制器自动裁决：${verdict} —— ${reason}`,
      },
      root,
    );

    console.log(`  ${formatMetrics(m)}　→ ${verdict}（${reason}）　${rec.id}`);
    outcomes.push({ variant, metrics: m, verdict, reason, experimentId: rec.id });

    if (verdict === "need_holdout" || verdict === "accept") {
      console.log(`  找到优于父版本的候选（cost ${m.cost} < ${parent.result.dev.cost}），停止搜索。`);
      break;
    }
  }

  // ── 4. 结论 ──
  console.log(`\n${"═".repeat(66)}\n结论`);
  const winner = outcomes.find((o) => o.verdict === "need_holdout" || o.verdict === "accept");
  if (winner) {
    console.log(`  最优候选：${winner.experimentId}　${formatMetrics(winner.metrics)}`);
    console.log(`  开关：${fix.switch}=1 ${JSON.stringify(winner.variant)}`);
    console.log(`  下一步（人做）：翻默认值 → 跑一次 holdout 确认 → status 改 accepted`);
  } else {
    console.log(`  **没有候选优于父版本**（试了 ${outcomes.length} 个，全部被闸门拒绝）`);
    for (const o of outcomes) console.log(`    ${JSON.stringify(o.variant)}　${o.verdict}：${o.reason}`);
    console.log(`  这条搜索路径到此为止 —— 需要在别的方向突破，而不是继续扫参数。`);
  }
  console.log(`  评测花费：$${spentUsd.toFixed(4)}　父版本 ${parent.id}\n`);
}

main();

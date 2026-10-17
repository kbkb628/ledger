/**
 * 任务执行器 —— RSI 五组件里的第 1 个。
 *
 * 拿一个「版本」跑完整业务任务，产出 **结果 + 执行轨迹**，并给所有产物盖上版本指纹。
 *
 * ## 设计原则：只做编排与归属，不重写测量逻辑
 *
 * 三个评测脚本跑出的数字就是已记录的基线，重构它们有把基线悄悄改掉的风险
 * （前面已经吃过「换尺子比数字」的教训）。所以：
 *
 *   脚本 → 结尾多调一次 `writeTaskResult`（逻辑一行不动）
 *   执行器 → 设 `RSI_RUN_DIR`、串行拉起脚本、聚合产物
 *
 * 好处是**执行器不可能改变任何数字** —— 它只在外面套了一层归属。
 *
 * ## 用法
 *
 *   npx tsx eval/executor.ts                      # 默认跑 r1
 *   npx tsx eval/executor.ts --task r1 --task judge --task e2e
 *   npx tsx eval/executor.ts --task r1 --reuse     # 冻结上游，只复跑 R1 层
 *   npx tsx eval/executor.ts --run-id exp-008      # 指定 run 目录名
 *
 * ## 产出
 *
 *   runs/<runId>/result.json        三组合并 + 版本指纹 + 总成本
 *   runs/<runId>/<task>.result.json 单任务汇总
 *   runs/<runId>/trace.jsonl        每个样本/每条标注一行
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeMetrics, formatMetrics } from "../src/rsi/metrics.js";
import { versionFingerprint } from "../src/rsi/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const TASKS = {
  judge: { script: "eval/run-eval.ts", args: ["--provider", "jev"] },
  e2e: { script: "eval/run-e2e.ts", args: [] },
  r1: { script: "eval/run-r1.ts", args: [] },
} as const;

type TaskName = keyof typeof TASKS;

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function collect(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith("--")) out.push(v);
    }
  });
  return out;
}

interface TaskArtifact {
  task: TaskName;
  metrics: Record<string, number | string | boolean>;
  extra?: Record<string, unknown>;
  evalCost?: { usd: number; seconds: number };
}

function main(): void {
  loadEnv(join(root, ".env"));

  const wanted = (collect("task").length ? collect("task") : ["r1"]) as TaskName[];
  for (const t of wanted) {
    if (!(t in TASKS)) throw new Error(`未知任务：${t}。可选：${Object.keys(TASKS).join(" / ")}`);
  }

  const runId = process.argv.includes("--run-id")
    ? (process.argv[process.argv.indexOf("--run-id") + 1] ?? "run")
    : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const runDir = join(root, "runs", runId);
  if (process.argv.includes("--fresh-run") && existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const version = versionFingerprint(root);
  console.log(`\n${"═".repeat(64)}`);
  console.log(`任务执行器 · run ${runId}`);
  console.log(`版本 ${version.hash}　commit ${version.commit}　prompt ${version.promptHash}`);
  console.log(`模型 ${version.extractModel} / ${version.judgeModel}`);
  const changed = Object.entries(version.flags).filter(([, v]) => v !== "default");
  console.log(`开关 ${changed.length ? changed.map(([k, v]) => `${k}=${v}`).join(" ") : "全部默认"}`);
  console.log(`任务 ${wanted.join(", ")}　产出 runs/${runId}/`);
  console.log(`${"═".repeat(64)}`);

  const failures: string[] = [];
  for (const task of wanted) {
    const { script, args } = TASKS[task];
    const extra = task === "r1" && process.argv.includes("--reuse") ? ["--reuse"] : [];
    const extraFresh = task === "r1" && process.argv.includes("--fresh") ? ["--fresh"] : [];
    console.log(`\n▶ ${task}（${script}）`);
    // Windows 上 npx 是 .cmd，必须用 npx.cmd + shell:false；
    // 用 shell:true 传 args 会触发 DEP0190 且参数不做转义
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const res = spawnSync(npx, ["tsx", script, ...args, ...extra, ...extraFresh], {
      cwd: root,
      stdio: "inherit", // 不接管 stdout，避免管道限制，也让进度可见
      env: { ...process.env, RSI_RUN_DIR: runDir },
    });
    if (res.status !== 0) failures.push(`${task}（退出码 ${res.status ?? "?"}）`);
  }

  // ── 聚合 ──
  const artifacts: TaskArtifact[] = [];
  for (const f of readdirSync(runDir).filter((x) => x.endsWith(".result.json"))) {
    artifacts.push(JSON.parse(readFileSync(join(runDir, f), "utf8")) as TaskArtifact);
  }

  const totalUsd = artifacts.reduce((a, x) => a + (x.evalCost?.usd ?? 0), 0);
  const traceLines = existsSync(join(runDir, "trace.jsonl"))
    ? readFileSync(join(runDir, "trace.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;

  const summary = {
    runId,
    at: new Date().toISOString(),
    version,
    tasks: Object.fromEntries(artifacts.map((a) => [a.task, a])),
    evalCost: { usd: totalUsd },
    traceLines,
    failures,
  };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n${"═".repeat(64)}`);
  console.log(`汇总 · run ${runId}`);
  for (const a of artifacts) {
    if (a.task === "r1") {
      const m = computeMetrics(Number(a.metrics.tp), Number(a.metrics.fp), Number(a.metrics.fn));
      console.log(`  r1    ${formatMetrics(m)}`);
    } else {
      console.log(`  ${a.task.padEnd(5)} ${Number(a.metrics.ok)}/${Number(a.metrics.total)}`);
    }
  }
  console.log(`  轨迹 ${traceLines} 行 · 评测成本 $${totalUsd.toFixed(4)}`);
  if (failures.length) console.log(`  ⚠️ 失败任务：${failures.join("、")}`);
  console.log(`  产物 runs/${runId}/result.json`);
  console.log(`${"═".repeat(64)}\n`);

  if (failures.length) process.exitCode = 1;
}

main();

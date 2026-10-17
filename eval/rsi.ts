/**
 * RSI 实验记录库的 CLI —— 组件 5 的操作面。
 *
 *   npx tsx eval/rsi.ts version            打印当前版本指纹
 *   npx tsx eval/rsi.ts list               列出全部实验
 *   npx tsx eval/rsi.ts show exp-003       看一条的完整记录
 *   npx tsx eval/rsi.ts table              用记录生成回合表（贴进 rsi-protocol.md）
 *   npx tsx eval/rsi.ts new --bucket ... --hypothesis ... --file ... --switch ...
 *   npx tsx eval/rsi.ts reject exp-003 --note "cost 未下降"
 *   npx tsx eval/rsi.ts accept exp-003 --note "cost 11 → 8，holdout 已确认"
 *
 * 设计原则：**记录先于改动**。动代码之前先建 exp 记录，拿到 parent 与版本指纹；
 * 改完把结果填进去。这样「为什么否决」不会随时间消失。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExperiment,
  currentFrontier,
  listExperiments,
  loadExperiment,
  renderRoundTable,
  setStatus,
  type ExperimentStatus,
  type FailureBucket,
  FAILURE_BUCKETS,
} from "../src/rsi/experiments.js";
import { analyze, type TraceEntry } from "../src/rsi/buckets.js";
import { computeMetrics, formatMetrics, judgeCandidate } from "../src/rsi/metrics.js";
import { renderProposal } from "../src/rsi/proposer.js";
import { versionFingerprint } from "../src/rsi/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

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

async function main(): Promise<void> {
  loadEnv(join(root, ".env"));
  const cmd = process.argv[2] ?? "list";

  switch (cmd) {
    case "version": {
      const v = versionFingerprint(root);
      console.log(JSON.stringify(v, null, 2));
      const f = currentFrontier(root);
      console.log(`\n当前前沿：${f ? `${f.id}（${f.status}）` : "（无，这将是基线）"}`);
      return;
    }

    case "list": {
      const rows = listExperiments(root);
      if (rows.length === 0) {
        console.log("还没有实验记录。用 `new` 建第一条。");
        return;
      }
      for (const e of rows) {
        console.log(
          `${e.id}  ${e.status.padEnd(9)} ${e.change.bucket.padEnd(20)} ` +
            `${e.change.switch.padEnd(16)} dev ${formatMetrics(e.result.dev)}` +
            `${e.parent ? `  ← ${e.parent}` : ""}`,
        );
      }
      return;
    }

    case "show": {
      const id = process.argv[3];
      if (!id) throw new Error("用法：show <exp-id>");
      console.log(JSON.stringify(loadExperiment(id, root), null, 2));
      return;
    }

    case "table": {
      console.log(renderRoundTable(root));
      return;
    }

    case "new": {
      const bucket = (arg("bucket") ?? "other") as FailureBucket;
      if (!FAILURE_BUCKETS.includes(bucket)) {
        throw new Error(`未知失败桶：${bucket}。可选：${FAILURE_BUCKETS.join(" / ")}`);
      }
      const hypothesis = arg("hypothesis");
      if (!hypothesis) throw new Error("--hypothesis 必填：一句话说清「为什么这个改动应该有效」");

      const parent = arg("parent") ?? currentFrontier(root)?.id ?? null;
      const dev = arg("tp") && arg("fp") && arg("fn")
        ? computeMetrics(Number(arg("tp")), Number(arg("fp")), Number(arg("fn")))
        : undefined;

      const rec = createExperiment(
        {
          parent,
          version: versionFingerprint(root),
          change: {
            bucket,
            hypothesis,
            file: arg("file") ?? "NONE",
            switch: arg("switch") ?? "NONE",
            params: arg("params") ? (JSON.parse(arg("params")!) as Record<string, string>) : {},
          },
          result: dev
            ? {
                dev,
                regression:
                  arg("judge") && arg("e2e")
                    ? { judge: Number(arg("judge")), e2e: Number(arg("e2e")) }
                    : undefined,
              }
            : {},
          evalCost: arg("usd") ? { usd: Number(arg("usd")), seconds: Number(arg("seconds") ?? 0) } : undefined,
        },
        root,
      );
      console.log(`${rec.id} 已建（parent=${rec.parent ?? "—"}，status=candidate）`);
      if (dev) console.log(`  dev: ${formatMetrics(dev)}`);
      return;
    }

    case "analyze": {
      const runId = process.argv[3];
      if (!runId) throw new Error("用法：analyze <run-id>");
      const tracePath = join(root, "runs", runId, "trace.jsonl");
      if (!existsSync(tracePath)) throw new Error(`没有轨迹文件 ${tracePath}`);
      const entries = readFileSync(tracePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TraceEntry)
        .filter((e) => e.kind === "annotation" || e.kind === "issue");

      const report = analyze(entries);
      console.log(`\n诊断 · run ${runId}（失败共 ${report.classified.length} 条）\n`);
      for (const h of report.histogram) {
        console.log(`  ${h.bucket.padEnd(20)} ${String(h.count).padStart(2)}  ${"█".repeat(h.count)}`);
        for (const w of h.why.slice(0, 3)) console.log(`      · ${w}`);
        if (h.why.length > 3) console.log(`      …另 ${h.why.length - 3} 条同类`);
      }
      if (report.top) {
        console.log(`\n本轮最大洞：${report.top.bucket}（${report.top.count} 条）\n`);
        console.log(renderProposal(report.top.bucket, report.top.count));
      }
      console.log("");
      return;
    }

    case "judge": {
      const id = process.argv[3];
      if (!id) throw new Error("用法：judge <exp-id>");
      const child = loadExperiment(id, root);
      const parent = child.parent ? loadExperiment(child.parent, root) : null;
      const { verdict, reason } = judgeCandidate(
        child.result.dev ?? computeMetrics(0, 0, 0),
        parent?.result.dev ?? null,
        child.result.regression && parent?.result.regression
          ? {
              judge: child.result.regression.judge,
              e2e: child.result.regression.e2e,
              parentJudge: parent.result.regression?.judge ?? 0,
              parentE2e: parent.result.regression?.e2e ?? 0,
            }
          : null,
        { candidate: child.result.devSet, parent: parent?.result.devSet },
      );
      console.log(`${child.id} vs ${parent?.id ?? "（无父版本）"} → ${verdict}`);
      console.log(`  理由：${reason}`);
      console.log(`  记录状态：${child.status}${child.note ? `　（${child.note.slice(0, 60)}）` : ""}`);
      console.log(
        verdict === "reject" && child.status !== "rejected"
          ? "  ⚠️ 裁决与记录不一致 —— 记录需要更新"
          : "  ✅ 裁决与记录一致",
      );
      return;
    }

    case "accept":
    case "reject": {
      const id = process.argv[3];
      if (!id) throw new Error(`用法：${cmd} <exp-id> --note "理由"`);
      const note = arg("note");
      if (!note) throw new Error(`--note 必填：${cmd} 必须留理由，否则「为什么」会丢`);
      const rec = setStatus(id, (cmd === "accept" ? "accepted" : "rejected") as ExperimentStatus, note, root);
      console.log(`${rec.id} → ${rec.status}：${rec.note}`);
      return;
    }

    default:
      console.log(`未知命令：${cmd}`);
      console.log("可用：version / list / show / table / new / judge / analyze / accept / reject");
  }
}

await main();

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { versionFingerprint, type VersionFingerprint } from "../rsi/version.js";

/**
 * 结构化输出 —— 任务执行器的采集口。
 *
 * ## 为什么是「脚本写文件」而不是「执行器进口函数」
 *
 * 三个评测脚本现在跑出的数字**就是已记录的基线**。把它们重构成模块会让测量逻辑搬家，
 * 有把基线悄悄改掉的风险（前面已经吃过「换尺子比数字」的教训）。
 *
 * 所以执行器**只做编排与归属**：脚本在结尾多调一次 `writeTaskResult`，
 * 逻辑一行不动。执行器再去读这些文件聚合。**保证不改变任何数字。**
 *
 * ## 产出
 *
 *   <runDir>/<task>.result.json   汇总：指标 + 版本指纹 + 成本
 *   <runDir>/trace.jsonl          每个样本/每条标注一行（追加）
 */

export interface TaskResult {
  task: "judge" | "e2e" | "r1" | "audit";
  /** 核心指标（字段随任务不同，但必须包含足够复算的东西） */
  metrics: Record<string, number | string | boolean>;
  /** 附加信息（配置、口径、警告） */
  extra?: Record<string, unknown>;
  /** 评测成本 */
  evalCost?: { usd: number; seconds: number };
}

/** 由执行器通过环境变量注入；单独跑脚本时没有，就不写文件 */
export function runDir(): string | null {
  const d = process.env.RSI_RUN_DIR?.trim();
  return d ? resolve(d) : null;
}

let cachedVersion: VersionFingerprint | null = null;
export function currentVersion(): VersionFingerprint {
  cachedVersion ??= versionFingerprint(process.cwd());
  return cachedVersion;
}

export function writeTaskResult(result: TaskResult, traceLines: string[] = []): void {
  const dir = runDir();
  if (!dir) return; // 独立运行时保持原样，只打印

  mkdirSync(dir, { recursive: true });
  const payload = {
    ...result,
    version: currentVersion(),
    finishedAt: new Date().toISOString(),
  };
  const file = join(dir, `${result.task}.result.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");

  if (traceLines.length > 0) {
    // 追加到统一的轨迹文件，每条带上 task 前缀，便于跨任务串读
    const all = traceLines.map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify({ task: result.task, at: new Date().toISOString(), ...obj });
    });
    writeFileSync(join(dir, "trace.jsonl"), `${all.join("\n")}\n`, { encoding: "utf8", flag: "a" });
  }
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Metrics } from "./metrics.js";
import { formatMetrics } from "./metrics.js";
import type { VersionFingerprint } from "./version.js";

/**
 * 版本与实验记录库 —— 保存候选、父版本、修改内容、结果与发布状态。
 *
 * ## 为什么它必须存在（而不是靠 `rsi-protocol.md` 手写表格）
 *
 * 手写表格能回答「改了什么、结果如何」，但答不上三个问题：
 *   1. 这个候选的**父版本**是谁？（于是不知道相对谁变好了）
 *   2. 这是**哪个代码/prompt/开关组合**跑出来的？（于是差异无法归因）
 *   3. 它现在是**候选、已接受、还是已否决**？（于是「能不能翻默认值」靠记忆）
 *
 * 记录一旦结构化，搜索控制器才能自己读它做决策 —— 那才是 RSI 与手工调参的分界。
 *
 * ## 目录
 *
 *   experiments/exp-001.json   一条记录一个文件（人可读、可 diff、进 git）
 *   分支用 git branch `rsi/exp-001`
 */

export const FAILURE_BUCKETS = [
  "no_usage",
  "masked_by_presence",
  "delta_self",
  "wrong_proposition",
  "should_allow",
  "other",
] as const;

export type FailureBucket = (typeof FAILURE_BUCKETS)[number];

export type ExperimentStatus = "candidate" | "accepted" | "rejected" | "released";

export interface ExperimentChange {
  /** 这次改的是哪个失败桶 */
  bucket: FailureBucket;
  /** 假设：一句话说清「为什么这个改动应该有效」 */
  hypothesis: string;
  /** 改的文件（最小修改原则：通常只有一个） */
  file: string;
  /** 动的开关名；上游改动写 "NONE"（这类必须重新生成基线） */
  switch: string;
  /** 开关的参数 */
  params: Record<string, string>;
}

export interface ExperimentResult {
  /** 决策集：改动用这个 */
  dev?: Metrics;
  /**
   * 决策集的身份（标注集的版本与规模）。
   *
   * ⚠️ **这一栏不加就会犯我们已经犯过的错**：3 条标注时 cost 上限只有 13，
   * 10 条时上限 34 —— 同一份 cost 换尺子就换了含义。
   * `judgeCandidate` 会拒绝跨标注集比较。
   */
  devSet?: { version: string; size: number };
  /** 留出集：只在决定翻默认值时跑一次 */
  holdout?: Metrics | null;
  /** 联合回归（条数，不是百分比），防优化一处弄坏另一处 */
  regression?: {
    judge: number;
    e2e: number;
    parentJudge?: number;
    parentE2e?: number;
  };
}

/**
 * 回合类型 —— **这是协议此前缺失的一类，也是我一路滑过去的原因**。
 *
 * - `capability`：改抽取/归并/规则等**能力**。必须用 P/R/cost 裁决，看是否优于父版本。
 * - `measurement`：改**打分器、指标定义、置信区间、匹配算法**。
 *   它不改变能力，但**会改变数字**，所以要求不同：
 *     ① 必须重建基线（旧数字与新数字不可比）
 *     ② 必须声明哪些历史结论作废
 *     ③ 不需要 P/R 裁决（没有"更好/更差"，只有"更对/更错"）
 *
 * 缺了这个分类，测量类改动就会被当成"顺手做的事"而不进实验库 —— 实际发生过。
 */
export type ExperimentKind = "capability" | "measurement";

export interface ExperimentRecord {
  id: string;
  kind?: ExperimentKind;
  parent: string | null;
  createdAt: string;
  version: VersionFingerprint;
  change: ExperimentChange;
  result: ExperimentResult;
  /** 评测成本（与指标成本分开：前者是跑一轮多贵，后者是业务代价） */
  evalCost?: { usd: number; seconds: number };
  status: ExperimentStatus;
  /** 判定理由 / 备注，必填于 rejected */
  note?: string;
}

export function experimentsDir(root = process.cwd()): string {
  return join(root, "experiments");
}

export function listExperiments(root = process.cwd()): ExperimentRecord[] {
  const dir = experimentsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ExperimentRecord)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadExperiment(id: string, root = process.cwd()): ExperimentRecord {
  const p = join(experimentsDir(root), `${id}.json`);
  if (!existsSync(p)) throw new Error(`没有实验记录 ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as ExperimentRecord;
}

const pad = (n: number): string => String(n).padStart(3, "0");

export function nextExperimentId(root = process.cwd()): string {
  const ids = listExperiments(root).map((e) => Number(/^exp-(\d+)$/.exec(e.id)?.[1] ?? 0));
  return `exp-${pad((ids.length ? Math.max(...ids) : 0) + 1)}`;
}

export function saveExperiment(rec: ExperimentRecord, root = process.cwd()): void {
  const dir = experimentsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2), "utf8");
}

export function createExperiment(
  input: {
    parent?: string | null;
    version: VersionFingerprint;
    change: ExperimentChange;
    result?: ExperimentResult;
    evalCost?: { usd: number; seconds: number };
    status?: ExperimentStatus;
    note?: string;
  },
  root = process.cwd(),
): ExperimentRecord {
  const rec: ExperimentRecord = {
    id: nextExperimentId(root),
    parent: input.parent ?? null,
    createdAt: new Date().toISOString(),
    version: input.version,
    change: input.change,
    result: input.result ?? {},
    evalCost: input.evalCost,
    status: input.status ?? "candidate",
    note: input.note,
  };
  saveExperiment(rec, root);
  return rec;
}

/** 改状态并留理由 —— rejected 必须写理由，否则「为什么否决」会丢 */
export function setStatus(id: string, status: ExperimentStatus, note: string, root = process.cwd()): ExperimentRecord {
  if ((status === "rejected" || status === "accepted" || status === "released") && !note.trim()) {
    throw new Error(`${status} 必须写理由`);
  }
  const rec = loadExperiment(id, root);
  rec.status = status;
  rec.note = note;
  saveExperiment(rec, root);
  return rec;
}

export function childrenOf(id: string | null, root = process.cwd()): ExperimentRecord[] {
  return listExperiments(root).filter((e) => e.parent === id);
}

/** 当前已接受/已发布的前沿版本 —— 新候选的默认父版本 */
export function currentFrontier(root = process.cwd()): ExperimentRecord | null {
  const accepted = listExperiments(root).filter((e) => e.status === "accepted" || e.status === "released");
  return accepted.at(-1) ?? null;
}

/**
 * 从实验记录**自动生成**回合表 —— 取代手写。
 * `rsi-protocol.md` 里那张表应由这个函数的输出粘贴而成。
 */
export function renderRoundTable(root = process.cwd()): string {
  const rows = listExperiments(root);
  if (rows.length === 0) return "（还没有实验记录）";
  const head =
    "| 实验 | 父版本 | 桶 | 改动 | dev | holdout | 回归(判定/端到端) | 成本 | 状态 | 理由 |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((e) => {
      const reg = e.result.regression
        ? `${e.result.regression.judge}/${e.result.regression.e2e}`
        : "—";
      const sw = e.change.switch === "NONE" ? "（上游）" : `${e.change.switch}${Object.keys(e.change.params).length ? ` ${JSON.stringify(e.change.params)}` : ""}`;
      return `| ${e.id} | ${e.parent ?? "—"} | ${e.change.bucket} | ${sw} | ${formatMetrics(e.result.dev)} | ${formatMetrics(e.result.holdout)} | ${reg} | ${e.evalCost ? `$${e.evalCost.usd.toFixed(3)}/${e.evalCost.seconds}s` : "—"} | ${e.status} | ${(e.note ?? "").replace(/\|/g, "／")} |`;
    })
    .join("\n");
  return `${head}\n${body}`;
}

/**
 * 把 RSI 回合表里的历史回合补录进实验记录库（幂等：已存在则跳过）。
 *
 * ## 为什么要补录而不是从今天开始记
 *
 * 历史回合里的知识（哪条改法被否决、为什么）如果只留在手写表格里，
 * 搜索控制器就读不到，新候选会重复踩已经踩过的坑。
 *
 * ## 一个必须写进备注的坑：**前 5 个回合与后 2 个回合的指标不可比**
 *
 * 回合 0–5 用的是 **3 条**泄漏标注；回合 6 扩到 **10 条**。
 * 同一份数字换尺子就变了含义（3 条时每条值 33pp，10 条时每条值 10pp）。
 * 所以每条记录的 note 里都标了基准版本；跨基准比较是无意义的。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { experimentsDir, listExperiments, saveExperiment, type ExperimentRecord } from "../src/rsi/experiments.js";
import { computeMetrics } from "../src/rsi/metrics.js";
import { versionFingerprint } from "../src/rsi/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const v = versionFingerprint(root);

interface Seed {
  id: string;
  parent: string | null;
  bucket: ExperimentRecord["change"]["bucket"];
  hypothesis: string;
  file: string;
  switch: string;
  params?: Record<string, string>;
  /** [tp, fp, fn]；缺省表示当时没有可比指标 */
  dev?: [number, number, number];
  devSet?: { version: string; size: number };
  holdout?: [number, number, number] | null;
  regression?: { judge: number; e2e: number };
  cost?: { usd: number; seconds: number };
  status: ExperimentRecord["status"];
  note: string;
}

const seeds: Seed[] = [
  {
    id: "exp-000", parent: null, bucket: "other",
    hypothesis: "起点：抽取记整句说法，无任何默认知识层",
    file: "NONE", switch: "NONE",
    dev: [1, 4, 2], devSet: { version: "v1", size: 3 }, status: "released",
    note: "基线 v0（3 条标注）。R1 起点：P 20.0% / R 33.3%",
  },
  {
    id: "exp-001", parent: "exp-000", bucket: "no_usage",
    hypothesis: "抽取记整句导致短引用匹配不上，改为记最短指代片段",
    file: "src/extraction/prompt.ts", switch: "NONE",
    status: "accepted",
    note: "基线 v0（3 条）。召回 33.3% → 100%（3/3）。当时未单独记录误报数",
  },
  {
    id: "exp-002", parent: "exp-001", bucket: "should_allow",
    hypothesis: "施事知道自己做的事，可用 agents 字段建默认知识层第一条规则",
    file: "src/audit/r1.ts", switch: "R1_AGENT",
    status: "accepted",
    note: "在正本《旧账》上测：误报 23 → 18（−21.7%）。与泄漏集指标不可比（任务不同）",
  },
  {
    id: "exp-003", parent: "exp-002", bucket: "should_allow",
    hypothesis: "命题首见场景的在场者应当得知它（窄化到首见场，避免泄给旁观者）",
    file: "src/audit/r1.ts", switch: "R1_PRESENCE",
    dev: [1, 1, 2], devSet: { version: "v1", size: 3 }, status: "accepted",
    note: "基线 v1（3 条）。冻结输入下精确率 16.7% → 50.0%（+33.3pp），确定差异",
  },
  {
    id: "exp-004", parent: "exp-003", bucket: "masked_by_presence",
    hypothesis: "知识挂在命题 A、使用在命题 B，R1 应提升到审计单元层比对",
    file: "src/audit/r1.ts", switch: "R1_UNITS",
    dev: [1, 1, 2], devSet: { version: "v1", size: 3 }, status: "rejected",
    note: "基线 v1（3 条）。冻结输入下精确率 50.0% → 50.0%（无变化）：promotion 在本剧本退化成 10 个单元素组，开关保留待更大标注集复验",
  },
  {
    id: "exp-005", parent: "exp-003", bucket: "wrong_proposition",
    hypothesis: "同一人物的不同称呼（沈父/林昭的父亲/老爷）被当成不同施事，应把别称表传给归并判定器",
    file: "src/extraction/merge.ts", switch: "R1_CHAR_HINT",
    dev: [1, 1, 2], devSet: { version: "v1", size: 3 }, status: "rejected",
    note: "基线 v0→v1 过渡（3 条）。P/R 66.7%/66.7% → 50.0%/33.3%，变差；但比较跨了新抽取、混着 33pp 抖动，严格说只是「无证据有效」。开关保留",
  },
  {
    id: "exp-006", parent: "exp-003", bucket: "other",
    hypothesis: "3 条标注每条值 33pp，与抖动同量级，先扩样本再谈改能力",
    file: "eval/leaks.json", switch: "NONE",
    dev: [3, 3, 7], devSet: { version: "v2", size: 10 }, status: "released",
    note: "基线 v2（10 条标注，冻结 eval/baseline/pipeline-leak.json）。P 50.0% / R 30.0%。扩样本时加硬规矩：每条泄漏的事实必须被安排在更早、泄漏者不在场的场景里确立",
  },
  {
    id: "exp-007", parent: "exp-006", bucket: "no_usage",
    hypothesis: "用 n-gram 稀有度派生识别键，匹配短引用",
    file: "src/audit/r1.ts", switch: "R1_SHORTKEY",
    params: { R1_KEY_LEN: "3,4", R1_KEY_FREQ: "1" },
    dev: [5, 8, 5], devSet: { version: "v2", size: 10 }, status: "rejected",
    note: "基线 v2（10 条，冻结）。精确率 50.0% → 38.5%（−11.5pp）、召回率 30.0% → 50.0%（+20pp）。精确率下降且低于 33pp 阈值，默认关；该产品误报比漏报更疼",
  },
];

function main(): void {
  const existing = new Set(listExperiments(root).map((e) => e.id));
  let created = 0;
  for (const s of seeds) {
    if (existing.has(s.id)) continue;
    const rec: ExperimentRecord = {
      id: s.id,
      parent: s.parent,
      createdAt: new Date().toISOString(),
      version: v,
      change: { bucket: s.bucket, hypothesis: s.hypothesis, file: s.file, switch: s.switch, params: s.params ?? {} },
      result: {
        dev: s.dev ? computeMetrics(...s.dev) : undefined,
        devSet: s.devSet,
        holdout: s.holdout ? computeMetrics(...s.holdout) : s.holdout === null ? null : undefined,
        regression: s.regression,
      },
      evalCost: s.cost,
      status: s.status,
      note: s.note,
    };
    saveExperiment(rec, root);
    created += 1;
  }
  console.log(`补录 ${created} 条（目录 ${experimentsDir(root)}）`);
}

main();

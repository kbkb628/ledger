/**
 * 诊断分桶 —— RSI 五组件里「评测器」的诊断部分，也是「改进提议器」的唯一输入。
 *
 * ## 为什么分桶比多跑几轮更值钱
 *
 * 10 条标注里，每条错都是人眼分析出来的；一个下午只能分析一轮。
 * 分桶把「错」从**一堆样本**变成**几个成因池**，同一批样本立刻多出一层信息：
 * 「本轮最大的洞是 no_usage（3 条）」比「P 50% / R 30%」可执行得多。
 *
 * ## 判据全部确定性，不用模型
 *
 * 输入是执行器的 `trace.jsonl`（`run-r1` 已把原料写全）：
 * 命题在不在、该处有没有使用点、最早的知情记录来自默认层还是抽取。
 *
 * ## 验证方式
 *
 * 它必须能复现人工分析过的那三条成因：
 *   no_usage ×3（L-04/L-06/L-08）、masked_by_presence ×2（L-02/L-05）、delta_self ×2（L-07/L-09）。
 * 复现不了就说明判据写错了 —— 这条验证比任何单元测试都硬。
 */

import type { FailureBucket } from "./experiments.js";

export interface TraceIssue {
  kind: "issue";
  verdict: "true_positive" | "false_positive" | "should_allow";
  scene: string;
  character: string;
  surface: string;
  propositionId?: string;
  mustNotFlag?: string | null;
  matched?: string[];
}

export interface TraceMiss {
  kind: "annotation";
  verdict: "missed";
  id: string;
  leakKind: "no_source" | "timing";
  scene: string;
  character: string;
  surface: string;
  ownerPropositions: string[];
  usageAtSite: boolean;
  earliestKnowledge: { scene: string; source: "extracted" | "default"; evidence: string } | null;
}

export type TraceEntry = TraceIssue | TraceMiss;

export interface Classified {
  entry: TraceEntry;
  bucket: FailureBucket;
  why: string;
}

/** 漏报的分桶 —— 三个判据互斥且可解释 */
export function classifyMiss(m: TraceMiss): { bucket: FailureBucket; why: string } {
  if (m.ownerPropositions.length === 0) {
    return { bucket: "wrong_proposition", why: "账本里没有包含该说法的命题（抽取层没抽出这件事）" };
  }
  if (!m.usageAtSite) {
    return {
      bucket: "no_usage",
      why: "命题存在，但泄漏那句里没有任何使用点命中 —— 说法形式与引用方式对不上",
    };
  }
  const k = m.earliestKnowledge;
  if (!k) {
    // 使用了、也没人记他知道 → 本该被抓到，却漏了。说明判定链有缺口。
    return { bucket: "other", why: "使用点存在且无知情记录，却未报出（判定链本身有缺口）" };
  }
  if (k.source === "default") {
    return {
      bucket: "masked_by_presence",
      why: `默认知识层在 ${k.scene} 授予了知情（${k.evidence}），把泄漏掩盖了`,
    };
  }
  if (k.scene === m.scene) {
    return {
      bucket: "delta_self",
      why: `抽取的 delta 记他在 ${k.scene} 得知 —— 而该场正是他自己说出这句话的场次`,
    };
  }
  return { bucket: "other", why: `知情记录来自 ${k.scene}（${k.source}），早于使用场 ${m.scene}` };
}

export function classifyIssue(i: TraceIssue): { bucket: FailureBucket; why: string } {
  if (i.mustNotFlag) {
    return { bucket: "should_allow", why: `命中了「应当放过」标注：${i.mustNotFlag}` };
  }
  return { bucket: "other", why: "报出但不对应任何标注泄漏，也不在「应当放过」名单里" };
}

export interface BucketReport {
  histogram: Array<{ bucket: FailureBucket; count: number; why: string[] }>;
  top: { bucket: FailureBucket; count: number } | null;
  classified: Classified[];
}

export function analyze(entries: TraceEntry[]): BucketReport {
  const classified: Classified[] = [];
  for (const e of entries) {
    if (e.kind === "annotation" && e.verdict === "missed") {
      const r = classifyMiss(e);
      classified.push({ entry: e, bucket: r.bucket, why: r.why });
    } else if (e.kind === "issue" && e.verdict !== "true_positive") {
      const r = classifyIssue(e as TraceIssue);
      classified.push({ entry: e, bucket: r.bucket, why: r.why });
    }
  }

  const map = new Map<FailureBucket, { count: number; why: string[] }>();
  for (const c of classified) {
    const cur = map.get(c.bucket) ?? { count: 0, why: [] };
    cur.count += 1;
    cur.why.push(c.why);
    map.set(c.bucket, cur);
  }

  const histogram = [...map.entries()]
    .map(([bucket, v]) => ({ bucket, count: v.count, why: v.why }))
    .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));

  return {
    histogram,
    top: histogram[0] ? { bucket: histogram[0].bucket, count: histogram[0].count } : null,
    classified,
  };
}

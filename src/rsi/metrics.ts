/**
 * 评测指标与成本口径 —— RSI 五组件里「评测器」的裁决部分。
 *
 * ## 为什么必须有标量成本
 *
 * 精确率 38.5% / 召回率 50% 与 50% / 30% 哪个好？没有标量就只能靠「觉得误报更疼」拍板。
 * 这不是 RSI，是手工调参。所以这里把取舍写成一个数：
 *
 *     cost = 误报数 × C_FP + 漏报数 × C_FN
 *
 * **权重是假设，不是事实**，理由见下。改权重是允许的，但必须改这里并说明为什么。
 */

/**
 * 一次人工复核的成本权重。
 * 口径：打开原句 → 判断真假 → 写豁免理由，约 1 个工作单位。
 */
export const C_FP = 1;

/**
 * 一次漏报的成本权重。
 * 口径：漏掉一条知识泄漏 ≈ 一场戏返工，约 3 个工作单位。
 *
 * ⚠️ 注意这不代表「误报比漏报轻」。误报真正的伤害是**会让人关掉工具**，
 * 而这一点无法用线性权重表达 —— 所以另设 `HARD_MAX_FP_RATE` 硬约束把它兜住。
 */
export const C_FN = 3;

/** 误报率超过这个值直接判不可用，不论 cost 多低 */
export const HARD_MAX_FP_RATE = 0.7;

export interface Metrics {
  /** 报出的问题数（= tp + fp） */
  reported: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  /** cost = fp × C_FP + fn × C_FN */
  cost: number;
  /** 误报率 = fp / reported */
  fpRate: number;
  /** 是否触发硬约束（不可用） */
  unusable: boolean;
}

export function computeMetrics(tp: number, fp: number, fn: number): Metrics {
  const reported = tp + fp;
  const precision = reported === 0 ? 0 : tp / reported;
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const fpRate = reported === 0 ? 0 : fp / reported;
  return {
    reported,
    tp,
    fp,
    fn,
    precision,
    recall,
    cost: fp * C_FP + fn * C_FN,
    fpRate,
    unusable: reported > 0 && fpRate > HARD_MAX_FP_RATE,
  };
}

/** 一行式展示，便于在日志与回合表里对齐 */
export function formatMetrics(m: Metrics | null | undefined): string {
  if (!m) return "—";
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return `P ${pct(m.precision)} / R ${pct(m.recall)} / cost ${m.cost}${m.unusable ? " ⛔不可用" : ""}`;
}

/** 候选相对父版本是否被接受 —— 控制器用的那条判定链 */
export type Verdict = "accept" | "reject" | "need_holdout" | "no_baseline" | "incomparable";

export function judgeCandidate(
  candidate: Metrics,
  parent: Metrics | null,
  regression: { judge: number; e2e: number; parentJudge: number; parentE2e: number } | null,
  devSets?: { candidate?: { version: string; size: number }; parent?: { version: string; size: number } },
): { verdict: Verdict; reason: string } {
  // 闸 0：**尺子必须相同**。
  // cost 的漏报上限由标注数量决定（3 条时 cost 上限 13，10 条时 34），
  // 所以跨标注集比较 cost 是无意义的 —— 我们已经在这上面栽过一次。
  if (devSets?.candidate && devSets?.parent) {
    const a = devSets.candidate;
    const b = devSets.parent;
    if (a.version !== b.version || a.size !== b.size) {
      return {
        verdict: "incomparable",
        reason: `标注集不同（${a.version}/${a.size} 条 vs ${b.version}/${b.size} 条），cost 不可比`,
      };
    }
  }

  // 闸 1：联合回归红线（任一退 ≥2 条）
  if (regression) {
    if (regression.parentJudge - regression.judge >= 2) {
      return { verdict: "reject", reason: `判定层退 ${regression.parentJudge - regression.judge} 条（红线 ≥2）` };
    }
    if (regression.parentE2e - regression.e2e >= 2) {
      return { verdict: "reject", reason: `端到端退 ${regression.parentE2e - regression.e2e} 条（红线 ≥2）` };
    }
  }
  // 闸 2：硬约束
  if (candidate.unusable) return { verdict: "reject", reason: `误报率 ${(candidate.fpRate * 100).toFixed(0)}% 超硬约束` };
  // 闸 3：**精确率回归护栏**。
  //
  // 为什么线性 cost 挡不住这个：exp-007 多抓 2 条泄漏（值 2×3=6）、多出 5 条误报（值 5×1=5），
  // net cost 只降 1 —— 按 cost 看"略有改善"，可精确率从 50% 掉到 38.5%。
  // 而精确率是对**用户信任**的直接度量，不能被打平在总量里。
  if (parent && parent.precision - candidate.precision > 0.1) {
    return {
      verdict: "reject",
      reason: `精确率退 ${((parent.precision - candidate.precision) * 100).toFixed(1)}pp（护栏 >10pp）`,
    };
  }

  // 闸 4：成本必须下降
  if (!parent) return { verdict: "no_baseline", reason: "无父版本可比，作为基线候选" };
  if (candidate.cost >= parent.cost) {
    return { verdict: "reject", reason: `cost ${candidate.cost} 未低于父版本 ${parent.cost}` };
  }
  // 闸 5：达标后仍需 holdout 确认才能翻默认值
  return { verdict: "need_holdout", reason: `cost ${candidate.cost} < ${parent.cost}，需 holdout 确认` };
}

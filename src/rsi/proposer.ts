/**
 * 改进提议器（组件 2a）—— 规则库版本，不用模型。
 *
 * 每个失败桶绑定一组**已知候选改法**，输出必须是**受限形式**：
 * `{ 开关, 参数, 文件 }` —— 只动一个开关，不许大面积重写。
 *
 * ## 为什么必须受限
 *
 * 不可执行、不可回退的提议等于没提。这里每条建议都要能被：
 *   1. 一条命令打开（`R1_XXX=1`）
 *   2. 一条命令关掉（默认值改回）
 *   3. 记进实验库并复验
 *
 * ## 为什么先做规则库而不是让模型提
 *
 * 桶 → 改法的映射本来就是**已知知识**（我前面几轮手工分析出来的）。
 * 先把它固化成表，提议器就能立刻不依赖我；等这张表覆盖不住了，再上模型。
 */

import type { FailureBucket } from "./experiments.js";

export interface CandidateFix {
  /** 一句话假设：为什么这个改动能治这个桶 */
  hypothesis: string;
  /** 要改的文件（最小修改原则：通常只一个） */
  file: string;
  /** 开关名；上游改动写 "NONE" */
  switch: string;
  /** 开关参数候选（同一桶可能有多个档，交给搜索控制器并发试） */
  variants: Array<Record<string, string>>;
  /** 这类改动是否需要重新生成上游基线（会引入抖动，必须换基线比对） */
  requiresNewBaseline: boolean;
  /** 已知的历史结论，避免重复踩坑 */
  prior: string;
}

export const BUCKET_FIXES: Record<FailureBucket, CandidateFix | null> = {
  no_usage: {
    hypothesis:
      "抽取记下的说法是整句，而别人只用短引用提它（「暗格里那份」vs「真正的那份遗嘱，在书房暗格里」），所以使用点扫不到",
    file: "src/audit/r1.ts",
    switch: "R1_SHORTKEY",
    variants: [
      { R1_KEY_LEN: "3,4", R1_KEY_FREQ: "1" },
      { R1_KEY_LEN: "4", R1_KEY_FREQ: "1" },
      { R1_KEY_LEN: "5,6", R1_KEY_FREQ: "1" },
    ],
    requiresNewBaseline: false,
    prior:
      "exp-007：最优档 3-4字/频≤1 把召回 30%→50%，但精确率 50%→38.5%，被精确率护栏否决。已试过参数扫描，需要在别的方向上突破（例如只在「同一审计单元内」用识别键，限制它的扩散面）",
  },
  masked_by_presence: {
    hypothesis:
      "泄漏台词本身被抽取当成事实的确立点，于是「首见场景在场者得知」把泄漏者自己的话变成了他的知识来源",
    file: "src/extraction/prompt.ts",
    switch: "R1_ESTABLISHED",
    variants: [{}],
    requiresNewBaseline: true,
    prior:
      "尚未实现。做法：抽取区分 established_at（事实被揭示/叙述的场）与 mentioned_at（被引用的场），mind 只从 established_at 起算。属于上游改动，会换基线",
  },
  delta_self: {
    hypothesis: "delta 抽取把「说话人自己说出的内容」记成了他得知，导致他反而成了知情者",
    file: "src/extraction/prompt.ts",
    switch: "R1_DELTA_SPEAKER",
    variants: [{}],
    requiresNewBaseline: true,
    prior:
      "尚未实现。成本极低：指令加一条硬约束「不要把说话人自己陈述的内容记成他得知」。属于上游改动",
  },
  should_allow: {
    hypothesis: "封闭世界假设下缺少「当事人 / 职责 / 公开事实」这类默认知情规则",
    file: "src/audit/r1.ts",
    switch: "R1_PATIENT",
    variants: [{}],
    requiresNewBaseline: false,
    prior:
      "R1_AGENT 与 R1_PRESENCE 已做（施事、在场者）。下一步是 patient（当事人/保管者），需要抽取层补 patients 字段",
  },
  wrong_proposition: {
    hypothesis: "同一事实被不同措辞抽成多条命题，归并没并上；知识挂一条、使用在另一条",
    file: "NONE",
    switch: "NONE",
    variants: [{}],
    requiresNewBaseline: true,
    prior:
      "这是端到端 60.4% vs 91.7% 的同一个缺口。exp-005（人物别称提示）试过，无证据有效。真正的方向是改写级归并质量与 promotion 质量",
  },
  other: null,
};

/** 挑出该桶的**首选**候选改法（取第一个参数档；多档由搜索控制器并发试） */
export function propose(bucket: FailureBucket): CandidateFix | null {
  return BUCKET_FIXES[bucket] ?? null;
}

/** 人类可读的一条提议 */
export function renderProposal(bucket: FailureBucket, count: number): string {
  const fix = propose(bucket);
  if (!fix) return `桶 ${bucket}（${count} 条）：没有已知改法 —— 需要人工分析，或先扩标注集`;
  const v = fix.variants[0] ?? {};
  const switches = fix.switch === "NONE" ? "（上游改动）" : `${fix.switch}${Object.keys(v).length ? ` ${JSON.stringify(v)}` : ""}`;
  return [
    `桶 ${bucket}（${count} 条）→ 候选改法：${switches}`,
    `  假设：${fix.hypothesis}`,
    `  文件：${fix.file}${fix.requiresNewBaseline ? "　⚠️ 需重新生成上游基线" : "　（只动 R1 层，可冻结比对）"}`,
    `  历史：${fix.prior}`,
  ].join("\n");
}

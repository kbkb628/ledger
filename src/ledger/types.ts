/**
 * 叙事账本的数据结构。
 *
 * ## 三条由实测决定的硬约束（见 docs/rsi-log.md）
 *
 * 1. **别名是一等公民**，不是缓存。判定准确率 +43.8pp 全靠它
 *    （差模型 + 有别名 = 91.7%，强模型 + 无别名 = 47.9%）。
 * 2. **每条别名带 `firstSeen`**。时序过滤是让上述结论可信的前提 ——
 *    否则等于用「命题未来才会积累的说法」去提示模型。
 * 3. **命题 / 知识 / 使用三者分离**。R1、R2、R3 的判据全部建立在这个分离上。
 */

export type SceneId = string;

/** 一条说法 —— 该命题在剧中出现过的某种称呼 */
export interface Alias {
  surface: string;
  /**
   * 首次出现的场景。**时序过滤的唯一依据**：
   * 处理场景 S 时只能使用 `firstSeen ≤ S` 的说法。
   */
  firstSeen: SceneId;
  source: "extracted" | "canonical" | "human";
}

/** 一条命题（账本的一「页」） */
export interface Proposition {
  id: string;
  /** 规范描述 —— 人可读，也是抽取层的产出 */
  canonical: string;
  /** 结构化三元组（主语 · 谓词 · 宾语） */
  relation?: string;
  /** 区分维度：与「同客体的其他命题」的分界 */
  distinguisher?: string;
  type: string;
  agent?: string;
  patient?: string;
  object?: string;
  timeRef?: string;
  /**
   * 累积的说法。**判定层的 keywords 即由此派生**（经时序过滤）。
   * wiki 的价值就在这张表随时间增长。
   */
  aliases: Alias[];
}

/** 角色心智：谁在何时以何种方式获知 / 相信 */
export interface KnowledgeRecord {
  character: string;
  scene: SceneId;
  factId: string;
  transition: "learns" | "believes" | "disbelieves" | "suspects" | "forgets";
  via: string;
  /**
   * `know`（可靠渠道）还是 `believe`（被欺骗 / 传闻）。
   * **泄漏判定看的是这两者之和，而不是客观真相** —— 误信也是「知道」。
   */
  stateKind: "know" | "believe";
}

/** 使用记录：谁在何时用到了某命题 */
export interface UsageRecord {
  character: string;
  scene: SceneId;
  factId: string;
  evidenceSpan: string;
}

/** 可序列化的账本快照 —— 用于持久化与测试 */
export interface LedgerSnapshot {
  sceneOrder: SceneId[];
  propositions: Proposition[];
  knowledge: KnowledgeRecord[];
  usages: UsageRecord[];
}

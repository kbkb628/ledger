/**
 * 判定层的公共类型。
 *
 * 对应 docs/design.md 6.4「判定接口」。三条设计约束必须体现在类型里：
 *  1. 答案空间被限定（allowedChoices）—— JEV 是 decision-only，不接受自由文本
 *  2. `UNSURE` 必须是合法选项 —— 否则模型被迫在两个错误答案里选一个
 *  3. 结果带 provider / latency / cost —— 单次调用即记账（喂给 pi-telemetry）
 */

export type MentionKind = "explicit_noun" | "repeated_surface" | "vague_pronoun";

/** 待绑定的说法及其上下文 */
export interface MentionState {
  surface: string;
  scene: string;
  /** 该说法所在的完整台词或邻近上下文 */
  context: string;
  kind: MentionKind;
}

/** 一条候选命题 */
export interface CandidateState {
  id: string;
  canonical: string;
  type: string;
  /**
   * 结构化关系三元组（主语 · 谓词 · 宾语 + 限定），用于**替代散文描述**。
   *
   * 依据 test-log.md 的架构实验：JEV 的短板是「需要推导」的判定。若把候选从
   * 散文换成三元组，判定就从「推演两者是否同指」退化为「线索与谓词是否匹配」——
   * 而后者属于 JEV 擅长的「判决可从文本直接读出」那一类。
   */
  relation?: string;
  /**
   * 区分性关键词：该命题的典型表述词。
   * 用于补回结构化表示压缩掉的**字面线索**（见 test-log.md：三元组曾弄丢「酒」字）。
   */
  keywords?: string[];
  /**
   * 区分维度：该命题与「同客体的其他命题」的分界（如 真伪 / 归属 / 存在性）。
   * 用于打破 F-002/F-009/F-010 这类「都围绕遗嘱」的混淆 —— 见 docs/rsi-log.md v2。
   */
  distinguisher?: string;
  agent?: string;
  patient?: string;
  object?: string;
  timeRef?: string;
  note?: string;
}

export interface JudgmentRequest {
  task: "bind_mention";
  mention: MentionState;
  candidates: CandidateState[];
  /**
   * 覆盖默认指令（`BIND_MENTION_INSTRUCTIONS`）。
   *
   * 用途：**同一套判定机制要服务两个不同的判定任务** ——
   *   - 指代绑定（mention → 命题）：默认指令
   *   - 命题归并（命题 → 命题）：`MERGE_PROPOSITIONS_INSTRUCTIONS`
   * 两者共享候选呈现方式（criteria）与答案空间约束，只有提问方式不同。
   */
  instructions?: string;
  /**
   * 合法答案集合。必须包含候选 id，以及 "NEW" 与 "UNSURE"。
   * NEW    = 不指向任何现有候选（应新建命题）
   * UNSURE = 线索不足或互相冲突，拒绝作答（触发升级）
   */
  allowedChoices: string[];
}

export interface JudgmentResult {
  choice: string;
  /** 各选项概率（若 provider 支持）。用于 margin 路由 */
  probabilities: Record<string, number>;
  confidence: number;
  provider: string;
  latencyMs: number;
  costUsd: number;
  /** 原始响应，便于排查 */
  raw?: string;
}

export interface JudgmentProvider {
  readonly name: string;
  judge(req: JudgmentRequest): Promise<JudgmentResult>;
}

/**
 * top1 与 top2 的概率间隔。
 *
 * ⚠️ 必须用**概率分布**计算，不能用 `confidence` —— 实测发现 JEV 的 `confidence`
 * 与 `probabilities[choice]` 不同源（例如 confidence=0.21，而选中项概率=0.34），
 * 两者相减会产生无意义的负数。`confidence` 保留为独立信号，不参与本计算。
 *
 * 无分布信息时（如单次采样的 OpenAI 兼容 provider，probabilities 只有一项）返回 1。
 */
export function marginOf(result: JudgmentResult): number {
  const probs = result.probabilities;
  const top = probs[result.choice] ?? result.confidence;
  const others = Object.entries(probs)
    .filter(([k]) => k !== result.choice)
    .map(([, v]) => v);
  if (others.length === 0) return 1;
  return top - Math.max(...others);
}

/** 候选集里若含 "other" 兜底类型，一律不参与自动归并（见 extraction-schema 4.1） */
export function isAutoMergeable(c: CandidateState): boolean {
  return c.type !== "other";
}

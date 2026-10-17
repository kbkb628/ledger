/**
 * 抽取层的产物类型。
 *
 * ## 范围（由实测砍定，见 docs/test-plan.md P1-2）
 *
 * P1-2 消融证明 `type/agent/patient/object/time_ref` 对判定**零贡献**，
 * 它们是 canonical 散文的派生冗余。所以抽取层只抽证据类字段：
 *
 *   证据 = canonical（命题表述） + surface（该命题在剧本里被怎么称呼）
 *
 * ## 为什么 surface 是核心产出
 *
 * RSI v1/v3 两轮实测：判定准确率的全部提升都来自「给它字面线索」
 * （keywords +43.8pp、上下文加宽 +8.3pp），而 keywords 的真实来源
 * 就是别名表 —— 一条命题在剧本里被怎么称呼过。**它是抽出来的，不是编的。**
 *
 * ## v1 的两处结构性改动（由 v0 的错并失败驱动）
 *
 * 1. **抽取只做场内**：v0 把「已抽出的命题清单」塞进 prompt 让模型自己判 ref，
 *    结果模型用「说法相似」当归并依据，把不同事件并成一条
 *    （E-005 一条吃掉了 F-002/F-005/F-006/F-008/F-009/F-011）。
 *    现在跨场归并**完全移出**抽取层，交给独立的归并层。
 * 2. **`reference_kind`**：区分明确指称与泛化指代。
 *    「两千三百万」是明确指称，「那份东西」是泛化指代 —— **后者是错并的唯一入口**。
 */

/**
 * 指称类型 —— 归并层的关键信号。
 *
 * - `explicit`    明确指称：含特有名词、数字、专名（「两千三百万」「联姻备忘录」）
 * - `descriptive` 描述性指称：用整句描述那件事（「你三年前在码头做了什么」）
 * - `vague`       泛化指代：靠上下文才能定指（「那件事」「那份东西」「「处理掉。烧了」」）
 *
 * ⚠️ `vague` 是**不能在归并时单独作为同一性证据**的一类：
 * 同一个「那份东西」在不同场次可以指完全不同的命题。
 */
export type ReferenceKind = "explicit" | "descriptive" | "vague";

export interface ExtractedSurface {
  /** 原文里的连续片段，逐字不改 */
  text: string;
  kind: ReferenceKind;
}

/** 一次抽取里，模型对**本场**某条命题的判断（不含任何跨场归并） */
export interface ScenePropositionDraft {
  canonical: string;
  surfaces: ExtractedSurface[];
  /**
   * 本场是否**确立**了这件事（作为信息揭示），而不是把它当已知前提**引用**。
   *
   * 这是 R1 的一个根因修复（`masked_by_presence`，见 rsi-protocol 第 8 回合）：
   * 泄漏台词本身也是一句断言，抽取会把它的场景当成事实的首见点，
   * 于是「首见场景在场者得知」把泄漏者自己的话变成了他的知识来源 —— 泄漏被自己掩盖。
   *
   * 区分方法：本场有没有给出这件事的**来源**（谁说的、何时发生、在哪看到）？
   * 给了 → 确立；只是当筹码/前提/质问用 → 引用。
   */
  established?: boolean;
  /**
   * **施事**：做这件事的人（没有施事时为空数组，如意外落水）。
   *
   * ⚠️ 这是**审计必需**字段，不是判定字段（P1-2 消融证明它对判定零贡献）。
   * R1 的默认知识层第一条规则就靠它：**施事天然知道自己的行为**。
   */
  agents: string[];
}

export interface SceneExtraction {
  scene: string;
  propositions: ScenePropositionDraft[];
  /** 本场发生的知识变化 —— R1 的 `mind(C)` 唯一来源 */
  knowledgeDeltas: KnowledgeDelta[];
}

/**
 * 一次知识变化 —— 「谁在本场得知了什么」。
 *
 * 这是 R1 判据 `used_at(S,P,C) ∧ P ∉ mind(C) at S` 里 `mind(C)` 的唯一来源。
 *
 * ⚠️ 它**不是命题**（粒度规则明确把「某人得知某事」排除出命题表）：
 * 命题是「客观事实」，知识变化是「某个角色对这个事实的认知状态变了」。
 * 之前把这两类混在一起，正是 v1 抽取粒度错误的来源之一。
 */
export interface KnowledgeDelta {
  /** 角色名，必须与剧本中的人名一致 */
  character: string;
  /** 指向本场某条命题的**原文连续片段**（与 surfaces 同一套「原文可查」约束） */
  about: string;
  kind: "learns" | "learns_false" | "suspects";
}

/** 归并后累积出的命题 */
export interface DraftProposition {
  id: string;
  canonical: string;
  /** 该命题积累到的所有说法，按首次出现的场景排序 */
  aliases: Array<{ surface: string; firstSeen: string; kind: ReferenceKind }>;
  /** 出现过该命题的场景（按处理顺序） */
  scenes: string[];
  /** 施事（跨场合并去重） */
  agents: string[];
  /**
   * 事实被**确立**的场景（首个 `established: true` 的场）；从未确立则为 null。
   * 缺省（undefined）表示这条命题来自没有 established 字段的旧账本，退回 `scenes[0]`。
   */
  establishedAt?: string | null;
}

/** 归并层的一次决策，落库后可用于复查与 waiver */
export interface MergeDecision {
  scene: string;
  canonical: string;
  choice: string;
  /** 判定时的候选（含 gold 之外的干扰项，用于日后复算） */
  candidates: string[];
  confidence: number;
  /** 被判定层拒绝的候选——用 `vague` 说法命中的候选不算证据 */
  reason: "attached" | "new" | "unsure" | "no_candidate" | "exact_surface" | "overlap_surface";
}

export interface LedgerDraft {
  propositions: DraftProposition[];
  /** 逐场抽取原始输出 */
  scenes: SceneExtraction[];
  /** 归并决策轨迹 */
  decisions: MergeDecision[];
  extract: { costUsd: number; latencyMs: number; calls: number; failures: Array<{ scene: string; error: string }>; rejectedSurfaces: number };
  merge: { costUsd: number; latencyMs: number; calls: number; unsure: number };
}

/** 某个说法在这一场是否是**首次**出现 —— 时序过滤的基础（见 rsi-log 实验纪律 2） */
export function firstSeenOf(
  aliases: Array<{ surface: string; firstSeen: string }>,
  surface: string,
): string | null {
  return aliases.find((a) => a.surface === surface)?.firstSeen ?? null;
}

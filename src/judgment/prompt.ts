import type { JudgmentRequest } from "./types.js";

/**
 * 判定指令模板 —— 对应 docs/design.md 6.5。
 *
 * 这段文字是 RSI 的**主要优化对象**，所以独立成模块、不散落在 provider 里。
 * 加版本号是为了：判定结果落库后，能追溯它是用哪版指令产出的。
 */
export const INSTRUCTION_VERSION = "0.1";

export const BIND_MENTION_INSTRUCTIONS = `判断「待绑定说法」在这段上下文中指的是哪一条候选命题。

线索优先级（从强到弱）：
1. 上下文中的实体词直接命中候选的 agent / patient / object
   （例如上下文出现「仓库」→ 命中 patient 含「仓库」的候选）
2. 说话人与候选的 agent 是否一致
3. 候选的 time_ref 与当前场景的时间层是否吻合
4. 候选最近被提及的场景与当前场景的距离

判定规则：
- 若没有任何候选被明确指向，选 NEW（表示这是一条新命题，需要新建）
- 若多条候选的线索强度接近、无法区分，选 UNSURE（表示拒绝作答）
- 若上下文信息不足以判断，选 UNSURE

重要：不要把「主题相似」当作「同一命题」的证据。
模糊指代（如「那件事」「那份东西」）可能指任何事，主题相近不足以判定。
必须找到实体词、时间、或说话人层面的具体线索才能绑定。`;

/**
 * 归并指令 —— 判断「新抽出的命题」是否与账本里已有的某条是**同一件事**。
 *
 * 与 `BIND_MENTION_INSTRUCTIONS` 同源（都是「这段文本指向哪条候选」），
 * 但答错的方向不同：
 *   - 指代绑定答错 → 一句话归错了命题
 *   - 归并答错   → **两条不同的事被并成一条，账本从此系统性失真**
 *
 * v0 的实测失败正是后者：一条「苏婉让陈默处理掉那份东西」吃掉了六条命题，
 * 靠的是「说法相似」而不是「事件同一性」。所以这条指令的核心是
 * **把「同客体重合」明确排除在同一性证据之外**。
 */
export const MERGE_PROPOSITIONS_INSTRUCTIONS = `判断「新命题」与候选命题列表中的哪一条描述的是**同一件事**。

同一件事 = 施事、受事/客体、发生的时间点三者都对得上。
只要这三点里有任一明显不同，就是**两件事**，必须选 NEW。

判定规则：
- 同一件事 → 选那条候选的 id
- 候选里没有任何一条是同一件事 → 选 NEW
- 候选间无法区分，或原文信息不足以确定 → 选 UNSURE

重要：以下都**不是**同一性证据，不要拿来当依据：
- 说法长得像、用词重合、或都含一个泛化指代（如都出现「那份东西」「那件事」）
- 主题相近、发生在同一个地点、或涉及同一个人
- 一条是另一条的**展开、后果、评论、或提及**

反例（必须选 NEW，不能因为都含「遗嘱」就并起来）：
- 「苏婉伪造并调换了沈父的遗嘱」（伪造行为）
  与「陈默手上持有沈父遗嘱的原件」（持有状态）
- 「沈父三年前立过一份遗嘱」（立遗嘱）
  与「沈父真正的遗嘱藏在怀表夹层里」（存放位置）

必须找到施事、客体、时间层面的**具体线索**才能判为同一件事。`;

/** 把请求渲染成人类可读的判定输入（provider 无关） */
export function renderRequest(req: JudgmentRequest): string {
  const { mention, candidates, allowedChoices } = req;

  const candidateLines = candidates
    .map((c) => {
      const fields: string[] = [];
      if (c.type) fields.push(`type=${c.type}`);
      if (c.agent) fields.push(`agent=${c.agent}`);
      if (c.patient) fields.push(`patient=${c.patient}`);
      if (c.object) fields.push(`object=${c.object}`);
      if (c.timeRef) fields.push(`time=${c.timeRef}`);
      // 典型表述：候选命题在剧本中**已积累**的说法（时序过滤后的别名）
      // 与 JEV 的 criteria 保持信息等价，使两个判定器的对比公平
      const kw = c.keywords?.length ? `\n    典型表述：${c.keywords.join("、")}` : "";
      const note = c.note ? `  // ${c.note}` : "";
      return `- ${c.id}: ${c.canonical}\n    ${fields.join("  ")}${kw}${note}`;
    })
    .join("\n");

  return `【待绑定说法】
原文：「${mention.surface}」
场景：${mention.scene}
类型：${mention.kind}
所在上下文：${mention.context}

【候选命题】
${candidateLines}

【可选答案】
${allowedChoices.join(" | ")}

只输出 JSON，不要任何解释或 markdown 代码块：
{"choice": "<上述可选答案之一>", "confidence": <0 到 1 之间的小数>}`;
}

/** 组装完整 prompt（system 指令 + 请求渲染） */
export function buildPrompt(req: JudgmentRequest): string {
  const instructions = req.instructions ?? BIND_MENTION_INSTRUCTIONS;
  return `${instructions}\n\n---\n\n${renderRequest(req)}`;
}

import type { JudgmentRequest, JudgmentProvider, JudgmentResult } from "./types.js";

/**
 * 零成本规则 provider —— 归并三层路由的「第 1 层」的简化版。
 *
 * 真实的第 1 层是**结构化字段全等匹配**（type + agent + patient + time_layer），
 * 但那需要抽取层的输出。本 provider 只做**实体词匹配**，作为基线：
 *
 *   候选的 patient / object 字符串出现在 mention 文本里 → 命中
 *
 * 它的价值不在于准，而在于回答「纯规则能走多远」。预期它会在模糊指代上
 * 大面积返回 UNSURE —— 这正是需要 judge 的部分（见 docs/design.md 6.2）。
 */
export class RuleProvider implements JudgmentProvider {
  readonly name = "rule";

  async judge(req: JudgmentRequest): Promise<JudgmentResult> {
    const started = Date.now();
    const text = `${req.mention.surface} ${req.mention.context}`;

    const hits = req.candidates.filter((c) => {
      const terms = [c.patient, c.object].filter((t): t is string => Boolean(t));
      // 只匹配受事与物件：agent 是人物名，几乎每句都出现，区分度为零
      return terms.some((t) => text.includes(t));
    });

    let choice: string;
    let confidence: number;

    if (hits.length === 1) {
      choice = hits[0]!.id;
      confidence = 0.9;
    } else if (hits.length === 0) {
      // 无任何实体线索。规则层无法区分「新命题」与「线索不足」，保守选 UNSURE
      choice = "UNSURE";
      confidence = 0.5;
    } else {
      // 多个命中 → 两难
      choice = "UNSURE";
      confidence = 0.5;
    }

    return {
      choice,
      probabilities: Object.fromEntries(req.allowedChoices.map((c) => [c, c === choice ? confidence : 0])),
      confidence,
      provider: this.name,
      latencyMs: Date.now() - started,
      costUsd: 0,
    };
  }
}

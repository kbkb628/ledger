/**
 * 候选召回的第二通道：**罕见词重合**（diverging from bigram-Dice）。
 *
 * ## 为什么需要它
 *
 * 归并的 blocking 用字符 bigram 的 Dice 相似度召回候选，下限 0.15。
 * 这个尺子对**同义改写**不友好：「保险箱的密码是小姐的生日」与「那把锁的密码，我试了两次就开了」
 * Dice 只有 0.07，直接掉出候选表 —— 判官连看都看不到，于是新建命题，
 * 「首见场景在场者得知」当场给泄漏者发许可（幻影集量到的就是这条）。
 *
 * 但这两句共享一个**很罕见**的词：「密码」。它在这个账本里只出现在一条命题上。
 * 所以正确的召回信号不是「整体像不像」，而是「有没有共享一个稀有词」。
 *
 * ## 做法
 *
 * 1. 归一化后切成字符 2-gram（与 blocking 同一套切法，便于对齐）；
 * 2. 在**当前账本**上算 IDF（跨命题的文档频率），罕见词权重高、烂大街的词权重低；
 * 3. 只有命中「足够罕见」的词（IDF 达阈）才算候选，再按权重和排序取前 K。
 *
 * 纯确定性：同一账本 + 同一句 → 同一候选表。不调模型。
 */

const DEFAULTS = {
  /** 命中词的 IDF 下限：低于它视为「人人都有的词」，不构成召回理由 */
  minIdf: 1.2,
  /** 取前 K 条候选 */
  topK: 4,
  /** 一句话最长按多少字符切（防止超长台词把候选算爆） */
  maxLen: 120,
};

export interface RecallInput {
  /** 归一化后的文本 */
  text: string;
  /** 命题的 id 与其可比较文本（canonical + 全部说法，已归一化） */
  props: Array<{ id: string; text: string }>;
  minIdf?: number;
  topK?: number;
}

/** 切成字符 2-gram（去空白；长度不足时退化为单字） */
export function grams(s: string): string[] {
  const t = s.replace(/\s+/g, "");
  if (t.length < 2) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i + 2 <= t.length; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 罕见词召回：返回按「罕见词权重和」排序的命题 id。
 * 一条命题若与文本没有任何达到 `minIdf` 的共同词，则**不进候选**。
 */
export function rareTermRecall(input: RecallInput): string[] {
  const minIdf = input.minIdf ?? DEFAULTS.minIdf;
  const topK = input.topK ?? DEFAULTS.topK;
  if (input.props.length === 0) return [];

  const textGrams = new Set(grams(input.text.slice(0, DEFAULTS.maxLen)));
  if (textGrams.size === 0) return [];

  const propGrams = input.props.map((p) => ({ id: p.id, g: new Set(grams(p.text)) }));

  // 文档频率：一个 2-gram 在多少条命题里出现过
  const df = new Map<string, number>();
  for (const { g } of propGrams) {
    for (const tok of g) {
      if (!textGrams.has(tok)) continue; // 只有共享词才需要权重
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
  }
  const n = propGrams.length;
  const idfOf = (tok: string): number => Math.log((n + 1) / ((df.get(tok) ?? 0) + 0.5));

  const scored = propGrams
    .map(({ id, g }) => {
      let score = 0;
      let rare = false;
      for (const tok of g) {
        if (!textGrams.has(tok)) continue;
        const idf = idfOf(tok);
        if (idf < minIdf) continue;
        rare = true;
        score += idf;
      }
      return { id, score, rare };
    })
    .filter((x) => x.rare)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);

  return scored.map((x) => x.id);
}

export const RECALL_DEFAULTS = DEFAULTS;

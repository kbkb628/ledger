/**
 * 命题匹配 —— 抽取层评测与端到端评测共用的唯一实现。
 *
 * 为什么要独立成模块：这两个脚本最初各写了一份匹配逻辑，
 * 结果「别名召回」在两处的口径不一致，白花了一轮时间去排查。
 *
 * ## 口径（踩过两次坑才定下来）
 *
 * 1. golden 别名是**短片段**（「我回来了」），抽取产出是**原文整行**
 *    （「三年前。我回来了。」）→ 必须**双向包含**匹配，且短串 ≥ 3 字。
 * 2. 包含匹配会造出**枢纽假命中**：`那份东西` 同时出现在多条 golden 别名里，
 *    一条抽出命题于是「命中」四条 → 必须**一对一贪心指派**：
 *    按匹配片段总长度降序，每个 golden 与每个抽出命题各只用一次。
 *    （用总长度排序而不是命中条数：越长的片段越具体，越可能是真匹配。）
 */

/** 归一化：去掉标点与空白，只留实义字符 */
export function norm(s: string): string {
  return s.replace(/[\s。，、！？：；「」（）·—…"']/g, "");
}

export interface MatchInfo {
  kind: "exact" | "contains";
  /** 匹配上的片段长度 —— 具体程度 */
  len: number;
}

/** 双向包含匹配；短串需 ≥ 3 字，避免过短片段乱命中。 */
export function matchInfo(alias: string, surface: string): MatchInfo | null {
  const a = norm(alias);
  const b = norm(surface);
  if (!a || !b) return null;
  if (a === b) return { kind: "exact", len: a.length };
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 3 && long.includes(short) ? { kind: "contains", len: short.length } : null;
}

/** 结构类型：只要求被测对象长得像命题，不绑定具体模块 */
export interface PropositionLike {
  id: string;
  canonical: string;
  aliases: Array<{ surface: string; firstSeen: string }>;
}

/** 某条候选命题对某条 golden 命题的匹配强度 = 命中别名的片段长度之和 */
export function pairScore(
  goldenAliases: Array<{ surface: string }>,
  p: PropositionLike,
): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (const a of goldenAliases) {
    let best = 0;
    for (const x of p.aliases) {
      const m = matchInfo(a.surface, x.surface);
      if (m) best = Math.max(best, m.len);
    }
    if (best > 0) {
      score += best;
      hits += 1;
    }
  }
  return { score, hits };
}

/**
 * 一对一贪心指派：golden 命题 → 抽出命题。
 *
 * 没被指派的 golden 命题 = 这条链路没覆盖它（抽漏或粒度差太远）。
 */
export function assignPropositions<G extends { id: string; aliases: Array<{ surface: string }> }>(
  golden: G[],
  props: PropositionLike[],
): Map<string, PropositionLike> {
  const pairs: Array<{ g: G; p: PropositionLike; score: number; hits: number }> = [];
  for (const g of golden) {
    for (const p of props) {
      const { score, hits } = pairScore(g.aliases, p);
      if (score > 0) pairs.push({ g, p, score, hits });
    }
  }
  pairs.sort((a, b) => b.score - a.score || b.hits - a.hits);

  const out = new Map<string, PropositionLike>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (out.has(pair.g.id) || used.has(pair.p.id)) continue;
    out.set(pair.g.id, pair.p);
    used.add(pair.p.id);
  }
  return out;
}

/** 字符二元组 Dice 系数 —— 只用于诊断「粒度差多远」，不参与指标 */
export function diceBigram(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = norm(s);
    const out = new Set<string>();
    for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

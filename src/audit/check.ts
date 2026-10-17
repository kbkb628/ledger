import { reconcileKnowledge, type KnowledgeFact } from "./r1.js";

/**
 * `ledger_check` 的内核 —— **写台词时当场判断会不会泄漏**。
 *
 * 这是整个产品最有价值的一处：不是写完再审，而是在 agent 提交一句台词**之前**拦住。
 *
 * ## 判据与 R1 相同，只是输入换成一行台词
 *
 *   命中某条命题的说法（surface ⊂ line，去空白后 ≥ 3 字）
 *   ∧ 说话人不在该命题的知情者里
 *   → 泄漏
 *
 * ## 与全文审计的两点差别（都是有意的）
 *
 * 1. **没给场景时按「全剧之后」算**，即所有已记录的知识都算已知。
 *    因为写手此刻通常在写新场次，未来的知识当然还不存在，而已发生过的都应该算。
 * 2. **豁免优先**。人工已确认豁免的 (角色, 命题) 直接跳过 —— 这是把误报变成
 *    「待确认项」的那一步，没有它这个工具没法用（当前误报率还不低）。
 */

export interface CheckInput {
  line: string;
  character: string;
  scene?: string;
}

export interface CheckHit {
  propositionId: string;
  canonical: string;
  /** 命中的说法 */
  surface: string;
  /** 该角色最晚一次被记录得知这条命题的场景；null = 从未记录 */
  knownAt: string | null;
  leak: boolean;
  waived: boolean;
  /** 给 agent 看的一句话理由 */
  reason: string;
}

const strip = (s: string): string => s.replace(/\s+/g, "");

export function checkLine(
  input: CheckInput,
  propositions: Array<{ id: string; canonical: string; aliases: Array<{ surface: string; firstSeen: string }> }>,
  knowledgeRaw: KnowledgeFact[],
  sceneOrder: string[],
  waivedKeys: Set<string>,
): CheckHit[] {
  const knowledge = reconcileKnowledge(knowledgeRaw);
  const line = strip(input.line);
  if (!line) return [];

  const idxOf = new Map(sceneOrder.map((s, i) => [s, i]));
  // 未指定场景 → 视为「全剧之后」：已记录的知识全部算已知
  const curIdx = input.scene ? (idxOf.get(input.scene) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;

  const hits: CheckHit[] = [];

  for (const p of propositions) {
    // 命中哪些说法
    const matched = p.aliases
      .map((a) => ({ surface: a.surface, needle: strip(a.surface) }))
      .filter((a) => a.needle.length >= 3 && line.includes(a.needle));
    if (matched.length === 0) continue;

    // 该角色最早一次被记录得知这条命题（同场得知后立刻使用是合法的）
    const known = knowledge.filter((k) => k.character === input.character && k.propositionId === p.id);
    const knownAt = known.length
      ? known.reduce((earliest, k) =>
          (idxOf.get(k.scene) ?? Number.POSITIVE_INFINITY) < (idxOf.get(earliest.scene) ?? Number.POSITIVE_INFINITY)
            ? k
            : earliest,
        ).scene
      : null;

    const knownIdx = knownAt ? (idxOf.get(knownAt) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    const waived = waivedKeys.has(`${input.character}|${p.id}`);
    const leak = !waived && knownIdx > curIdx;

    hits.push({
      propositionId: p.id,
      canonical: p.canonical,
      surface: matched[0]!.surface,
      knownAt,
      leak,
      waived,
      reason: waived
        ? `已豁免：${input.character} 对这条命题不需要知情记录`
        : leak
          ? knownAt === null
            ? `全剧没有记录 ${input.character} 得知过这条命题`
            : `${input.character} 到 ${knownAt} 才得知这条命题，这里提前用到了`
          : `${input.character} 在 ${knownAt ?? "此前"} 已得知，合法`,
    });
  }

  return hits;
}

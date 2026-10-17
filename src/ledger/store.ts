import type {
  Alias,
  KnowledgeRecord,
  LedgerSnapshot,
  Proposition,
  SceneId,
  UsageRecord,
} from "./types.js";

/**
 * 叙事账本 —— 命题 + 别名累积 + 知识与使用记录。
 *
 * `aliasesAt()` 是整个判定链的地基：它按**时间因果**给出「处理到某一刻时，
 * 账本里真实已经积累的说法」。实测表明这正是差模型能追上强模型的原因。
 *
 * 设计原则：**保守**。凡是无法确定时序的（未知场景），一律不返回该说法 ——
 * 宁可少给线索，也不能把未来信息泄露给判定层。
 */
export class Ledger {
  private readonly props = new Map<string, Proposition>();
  private readonly knowledge: KnowledgeRecord[] = [];
  private readonly usages: UsageRecord[] = [];
  private sceneOrder: SceneId[] = [];
  private seq = 0;

  // ── 场景顺序 ────────────────────────────────────────────

  /** 设定场景的处理顺序。它定义了「时间因果」，必须先于查询设好。 */
  setSceneOrder(order: SceneId[]): void {
    this.sceneOrder = [...order];
  }

  /** A 是否**不晚于** B（叙事顺序）。未知场景返回 false（保守） */
  notAfter(a: SceneId, b: SceneId): boolean {
    const i = this.sceneOrder.indexOf(a);
    const j = this.sceneOrder.indexOf(b);
    if (i < 0 || j < 0) return false;
    return i <= j;
  }

  // ── 命题与别名 ──────────────────────────────────────────

  createProposition(
    input: Omit<Proposition, "id" | "aliases">,
    scene: SceneId,
    id?: string,
  ): Proposition {
    const pid = id ?? `F-${String(++this.seq).padStart(3, "0")}`;
    const p: Proposition = { ...input, id: pid, aliases: [] };
    this.props.set(pid, p);
    // 规范描述本身也算一种说法，其首次出现即该命题建立之时
    if (input.canonical) this.attachAlias(pid, input.canonical, scene, "canonical");
    return p;
  }

  /**
   * 把一个说法挂到命题上。
   * 重复说法只保留**最早**的 `firstSeen`（首次出现才有时序意义）。
   */
  attachAlias(
    id: string,
    surface: string,
    scene: SceneId | undefined,
    source: Alias["source"] = "extracted",
  ): void {
    const p = this.props.get(id);
    if (!p) throw new Error(`命题不存在：${id}`);
    const s = surface.trim();
    if (!s) return;

    const existing = p.aliases.find((a) => a.surface === s);
    if (existing) {
      const sceneStr = scene ?? "";
      const earlier =
        !existing.firstSeen || (sceneStr && this.notAfter(sceneStr, existing.firstSeen));
      if (earlier && sceneStr) existing.firstSeen = sceneStr;
      return;
    }
    p.aliases.push({ surface: s, firstSeen: scene ?? "", source });
  }

  get(id: string): Proposition | undefined {
    return this.props.get(id);
  }

  all(): Proposition[] {
    return [...this.props.values()];
  }

  /**
   * 处理到场景 `scene` 时，该命题**已经积累的剧中说法** —— 判定层的 `keywords`。
   *
   * ⚠️ **刻意排除 `source === "canonical"`**：canonical 是抽取层产出的**规范描述**
   * （长句），不是剧中的说法。它由 `canonical` 字段独立承载；若混进 keywords，
   * 会稀释真正的字面线索 —— 实测准确率因此下降约 2pp。
   *
   * 未设场景顺序时返回空数组：刻意的保守行为，避免在时序未定义时静默退化成
   * 「全量别名」（那正是早期实验的效度缺陷）。
   */
  aliasesAt(id: string, scene: SceneId): string[] {
    const p = this.props.get(id);
    if (!p) return [];
    if (this.sceneOrder.length === 0) return [];
    return p.aliases
      .filter((a) => a.source !== "canonical")
      .filter((a) => a.firstSeen && this.notAfter(a.firstSeen, scene))
      .map((a) => a.surface);
  }

  /** 供判定请求使用：候选命题在该时点的完整视图 */
  candidateViewAt(id: string, scene: SceneId): {
    proposition: Proposition;
    keywords: string[];
  } | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    return { proposition: p, keywords: this.aliasesAt(id, scene) };
  }

  // ── 知识与使用 ──────────────────────────────────────────

  addKnowledge(rec: KnowledgeRecord): void {
    this.knowledge.push(rec);
  }

  addUsage(rec: UsageRecord): void {
    this.usages.push(rec);
  }

  /** 某角色在某场景**已经**掌握（知道或相信）的命题 id 集合 */
  knownByAt(character: string, scene: SceneId): Set<string> {
    const out = new Set<string>();
    for (const k of this.knowledge) {
      if (k.character !== character) continue;
      if (k.transition === "suspects") continue; // 怀疑不等于知道，不参与泄漏判定
      if (this.notAfter(k.scene, scene)) out.add(k.factId);
    }
    return out;
  }

  knowledges(): readonly KnowledgeRecord[] {
    return this.knowledge;
  }

  allUsages(): readonly UsageRecord[] {
    return this.usages;
  }

  // ── 持久化 ──────────────────────────────────────────────

  snapshot(): LedgerSnapshot {
    return {
      sceneOrder: [...this.sceneOrder],
      propositions: [...this.props.values()].map((p) => ({ ...p, aliases: [...p.aliases] })),
      knowledge: [...this.knowledge],
      usages: [...this.usages],
    };
  }

  static fromSnapshot(snap: LedgerSnapshot): Ledger {
    const l = new Ledger();
    l.setSceneOrder(snap.sceneOrder);
    for (const p of snap.propositions) {
      l.props.set(p.id, { ...p, aliases: [...p.aliases] });
      const n = Number(p.id.replace(/^F-/, ""));
      if (Number.isFinite(n) && n > l.seq) l.seq = n;
    }
    for (const k of snap.knowledge) l.knowledge.push(k);
    for (const u of snap.usages) l.usages.push(u);
    return l;
  }
}

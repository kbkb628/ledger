import type { SceneExtraction, DraftProposition } from "../extraction/types.js";
import type { Scene } from "../extraction/script.js";
/**
 * R1 知识泄漏检测 —— 产品的核心输出。
 *
 *   泄漏 ⟺ used_at(S, P, C) ∧ P ∉ mind(C) at S
 *
 * ## 为什么 usages 是「免费」的
 *
 * 抽取层产出的每条 `surface` 就是一个**说法**（「那件事」「两千三百万」），
 * 它带着自己首次出现的场景；归并后它挂在某条命题上。**那就是一次 use。**
 * 说话人从台词前缀（`角色：`）直接可得，叙述行没有前缀 → 不是角色的使用。
 *
 * 所以 R1 只剩一个未知量：`mind(C)`（谁在第几场知道了什么），
 * 由抽取层的 `knowledge_deltas` 提供。
 *
 * ## 封闭世界假设（必须显式选定，见 design.md 3.4）
 *
 *   knows(C, P) ⟺ 存在一条 (C, P) 的知识变化，且场景不晚于当前场景
 *
 * 反面就是：**没记到就是不知道**。这会天然误报 —— 角色可能通过
 * 别人转述、旁听、常识推断知道某件事，而剧本没有明确演出。
 * 所以第一版**不加任何豁免**，先把误报全暴露出来逐条看（见 test-plan.md）。
 */

/** 一次「角色用到了某条命题」 */
export interface Usage {
  character: string;
  propositionId: string;
  scene: string;
  surface: string;
  line: string;
}

/** 一条知识状态变化（已解析到命题） */
export interface KnowledgeFact {
  character: string;
  propositionId: string;
  scene: string;
  kind: "learns" | "learns_false" | "suspects";
  evidence: string;
  /**
   * 这条知情的来源。**显式记录优先于默认推断** ——
   * 见 `reconcileKnowledge`：实测（test-plan.md §5.11）里，默认规则在
   * 「泄漏台词本身」那场授予的知情会掩盖时序泄漏，所以只要同一 (角色, 命题)
   * 有显式记录，默认推断就一律作废。
   */
  source?: "extracted" | "default";
}

export interface LeakIssue {
  character: string;
  propositionId: string;
  canonical: string;
  useScene: string;
  surface: string;
  line: string;
  /** 该角色**最晚一次**得知这条命题的场景；null = 全剧都没记到他得知 */
  knownAt: string | null;
}

/** 从台词行取说话人。叙述行（无 `角色：` 前缀）返回 null。 */
export function speakerOf(line: string): string | null {
  const t = line.trim();
  // 叙述/舞台指示的常见起手：〔〕（）【】「」《》——一律不是说话人。
  // 这一条是被真实剧本打出来的：《茶馆》里 `〔幕启：北京城内的大茶馆…` 形如
  // 「短前缀 + 冒号」，被当成说话人，于是报了 8 条「〔幕启 用到了…」。
  // 我自造的剧本从没写过带冒号的叙述行，所以合成测试永远测不到这个 bug。
  if (/^[〔（(\[【〈《<]/.test(t)) return null;
  const m = /^([^\s：:，。！？「」（）〔〕、；]{1,6})[：:]/.exec(t);
  if (!m) return null;
  const name = m[1]!;
  if (!/^[\u4e00-\u9fffA-Za-z0-9·]+$/.test(name)) return null;
  if (/^(幕启|幕落|时间|地点|人物|旁白|注|附注)/.test(name)) return null;
  return name;
}

/**
 * 说法匹配：从命题的**整句表面**里派生短的「识别键」。
 *
 * ## 为什么需要（实测，test-plan.md §5.11 / rsi-protocol 第 6 回合）
 *
 * 抽取记下的说法常常是整句（「真正的那份遗嘱，在书房暗格里」），
 * 而别人只会用**短引用**去提它（「暗格里那份」）——双向包含都不成立，
 * 使用点根本扫不到，泄漏自然看不见（L-04/L-06/L-08 就是这么漏的）。
 *
 * ## 做法：n-gram + 稀有度过滤（完全确定性，不调模型）
 *
 * 1. 把命题的所有说法拼成文本，取 3–4 字的连续片段作为候选键
 * 2. 只保留**稀有**的：在其他命题里很少出现的键才有辨识度
 *    （「那份」这类到处都有的会被自动滤掉）
 * 3. 键必须出现在该命题的**说法**里，而不只是 canonical（避免编造）
 */
function deriveKeys(
  props: Array<{ id: string; aliases: Array<{ surface: string }> }>,
  gramLen?: number[],
  maxFreq?: number,
): Map<string, string[]> {
  // 参数可调（同一个杠杆的不同档位，见 rsi-protocol 第 6 回合）：
  //   键越长越有辨识度、命中越少；稀有度上限越严、误报越少
  const lens =
    gramLen ??
    (process.env.R1_KEY_LEN ?? "3,4")
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n >= 2);
  const freqCap = maxFreq ?? Number(process.env.R1_KEY_FREQ ?? 2);
  const strip = (s: string): string => s.replace(/\s+/g, "");
  const keySets = new Map<string, Set<string>>();

  for (const p of props) {
    const set = new Set<string>();
    for (const a of p.aliases) {
      const t = strip(a.surface);
      for (const n of lens) {
        for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
      }
    }
    keySets.set(p.id, set);
  }

  // 每个键出现在多少条命题里
  const freq = new Map<string, number>();
  for (const set of keySets.values()) for (const k of set) freq.set(k, (freq.get(k) ?? 0) + 1);

  const out = new Map<string, string[]>();
  for (const [id, set] of keySets) {
    out.set(
      id,
      [...set].filter((k) => (freq.get(k) ?? 0) <= freqCap),
    );
  }
  return out;
}

/**
 * 收集 usages：扫描**全部场景**里出现过的该命题的每个说法。
 *
 * 为什么不只用 `firstSeen`：`firstSeen` 只记首次出现的场景，而「使用」发生在每一次
 * 被引用的时候。只取首见会让大量使用点被漏掉（R1 的漏报主要来自这里）。
 *
 * 噪声控制：
 * - 说法去掉空白后长度必须 ≥ 3 —— 「在。」这种两字片段会命中一切
 * - `shortKeys: true` 时额外用派生识别键去匹配短引用（`R1_SHORTKEY` 开关）
 */
export function buildUsages(
  ledger: DraftProposition[],
  scenes: Scene[],
  opts: { shortKeys?: boolean; skipNames?: boolean } = {},
): { usages: Usage[]; droppedShort: number; keyMatches: number } {
  const usages: Usage[] = [];
  let droppedShort = 0;
  let keyMatches = 0;
  const keys = opts.shortKeys ? deriveKeys(ledger) : undefined;
  // 说话人名集合：**提到一个人名 ≠ 使用了关于他的命题**。
  // 真实剧本测试暴露（《茶馆》12 条里有 3 条）：命题「小二德子埋伏下了打手」的说法被抽成
  // 「小二德子」，于是任何角色提到这三个字就命中。纯字面缺陷，确定性排除。
  const personNames = new Set(ledger.flatMap((p) => p.agents));

  for (const p of ledger) {
    const surfaces = [...new Set(p.aliases.map((a) => a.surface))];
    const propKeys = keys?.get(p.id) ?? [];

    for (const scene of scenes) {
      for (const line of scene.lines) {
        const flat = line.replace(/\s+/g, "");
        // ① 整句说法包含
        const direct = surfaces.filter((s) => {
          const n = s.replace(/\s+/g, "");
          if (opts.skipNames !== false && personNames.has(n)) return false; // 人名本身不算引用
          return n.length >= 3 && flat.includes(n);
        });
        // ② 派生识别键（短引用）
        const viaKey = propKeys.filter((k) => flat.includes(k));
        if (direct.length === 0 && viaKey.length === 0) continue;

        const character = speakerOf(line);
        if (!character) continue; // 叙述/旁白不算角色的使用

        const surface = direct[0] ?? viaKey[0]!;
        if (direct.length === 0) keyMatches += 1;
        if (usages.some((u) => u.surface === surface && u.scene === scene.id && u.character === character)) continue;
        usages.push({ character, propositionId: p.id, scene: scene.id, surface, line: line.trim() });
      }
    }
  }

  for (const p of ledger) {
    for (const a of p.aliases) if (a.surface.replace(/\s+/g, "").length < 3) droppedShort += 1;
  }

  return { usages, droppedShort, keyMatches };
}

/**
 * 从场景元数据里取在场者。
 *
 * 剧本的场次头一直是 `- 在场：林昭、周管`。这条信息零成本、完全确定，
 * 之前只顾着抽 `agents` 把它漏了（见 test-plan.md §5.11）。
 */
export function presentCharacters(scene: Scene | undefined): string[] {
  if (!scene) return [];
  // 场次头是**一整行**：「时间锚：现在 · 地点：书房 · 在场：林昭、周管」
  // 所以不能 startsWith，要按 · 切开逐段找（早期版本就栽在这里，规则静默失效）
  for (const entry of scene.meta) {
    for (const seg of entry.split(/[·・|]/)) {
      const m = /^\s*在场[：:]\s*(.+)$/.exec(seg);
      if (!m) continue;
      return m[1]!
        .split(/[、,，/／\s]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== "无");
    }
  }
  return [];
}

/**
 * 默认知识层 —— 封闭世界假设的必要补丁。
 *
 * `knows(C,P) ⟺ 有知识变化记录` 太粗：角色知道很多**剧本没有明确演出**的事。
 * 这里按**一条规则一条规则地加**，每加一条都量一次误报降幅，
 * 而不是一次塞一堆凭直觉的豁免。
 *
 * 规则 1：**施事知道自己做的事。**
 *   苏婉用「那份东西」——那是她自己下令烧的，不是泄漏。
 *
 * 规则 2：**命题首见场景的在场者得知它。**
 *   一个事实在某场被第一次公开说出来，在场的人就都知道了。
 *   实测依据（test-plan.md §5.11）：这条能修掉 4 条误报里的 3 条
 *   （周管亲历老爷去世、何静本人经手公证、周管自己说的那句），
 *   而**不会**放过 L-01（陈立不在 S02-01 现场）或 L-03（周管不在 S04-01 现场）。
 *
 *   ⚠️ 刻意窄化到「**首见场景**」而不是「出现过的每场」：
 *   宽版本等于说「只要在某场出现过，全场就都知道了」，会把私下对话里的秘密泄给旁观者。
 *
 * 刻意**没有**加的规则（都还缺依据）：
 *   - 职责性知情（律师/财务总监）：需要角色职责表，剧本里没有显式声明。
 *   - 公开在册事实：需要事实类型（`type`），而抽取层按最小范围没抽它。
 *   - 特殊设定（重生/穿越/卧底）：**永远无法从剧本推断**，必须由作者显式声明。
 */
/** 事实被「确立」的场次 —— 有 establishedAt 用它，旧账本退回首见场 */
function establishedSceneOf(p: DraftProposition): string | undefined {
  return p.establishedAt === undefined ? p.scenes[0] : (p.establishedAt ?? p.scenes[0]);
}


/**
 * 某角色视角下，这条命题**首次由他人披露**的场次。
 *
 * ## 为什么需要（这是「不得自证」原则的落地）
 *
 * `masked_by_presence` 这个洞的机制是：**泄漏台词本身就是该事实的首次出现**，
 * 于是「首见场景在场者得知」把泄漏者自己那句话，变成了他"得知"的证据 —— 泄漏自我掩盖。
 *
 * 这与 STAGE 基准里那条标注约束是同一件事：
 * **「同场次后续证据不得回流为前置知识」**（防 future leakage）。
 *
 * 所以规则应当是：**一个人不能用自己的台词作为自己知情的来源。**
 * 只有当某条命题的说法出现在**别人说的台词**（或叙述行）里，且该角色在场，才算他得知。
 *
 * 副作用（必须承认）：如果某条事实全剧只有当事人自己说过（如「老爷半年前就走了」），
 * 这条规则会让他失去"在场知情"，从而可能误报。这类应由「当事人/亲历」类规则覆盖，
 * 不能靠这条兜底 —— 所以要实测净收益。
 */
function firstDisclosureScene(
  p: DraftProposition,
  character: string,
  scenes: Scene[],
): string | undefined {
  const surfaces = [...new Set(p.aliases.map((a) => a.surface.replace(/\s+/g, "")))].filter(
    (s) => s.length >= 3,
  );
  if (surfaces.length === 0) return undefined;
  for (const scene of scenes) {
    for (const line of scene.lines) {
      const flat = line.replace(/\s+/g, "");
      if (!surfaces.some((s) => flat.includes(s))) continue;
      const sp = speakerOf(line);
      if (sp === character) continue; // 自己说的，不能自证
      return scene.id;
    }
  }
  return undefined;
}
export function defaultKnowledge(
  ledger: DraftProposition[],
  scenes?: Scene[],
  opts: { agent?: boolean; presence?: boolean; established?: boolean; noSelfEstablish?: boolean } = {},
): Array<{ character: string; propositionId: string; scene: string }> {
  const useAgent = opts.agent ?? true;
  const usePresence = opts.presence ?? true;
  // R1_ESTABLISHED：在场者规则从「确立场」而不是「首见场」起算。
  // 关掉即退回旧行为（首见场），用于 A/B 与回退。
  const useEstablished = opts.established ?? true;
  // R1_NO_SELF_ESTABLISH：不得用自己台词作为自己知情来源（治 masked_by_presence）
  const noSelfEstablish = opts.noSelfEstablish ?? false;
  const out: Array<{ character: string; propositionId: string; scene: string }> = [];
  const byId = new Map((scenes ?? []).map((s) => [s.id, s]));

  for (const p of ledger) {
    const scene = p.scenes[0];
    if (!scene) continue;

    // 规则 1：施事
    if (useAgent) {
      for (const agent of p.agents) {
        out.push({ character: agent, propositionId: p.id, scene });
      }
    }

    // 规则 2：**确立**场景的在场者（不是首见场 —— 泄漏台词本身也会成为首见场）
    if (usePresence) {
      const grantScene = useEstablished ? (establishedSceneOf(p) ?? scene) : scene;
      for (const who of presentCharacters(byId.get(grantScene))) {
        if (p.agents.includes(who)) continue; // 已由规则 1 覆盖
        // 规则 2b：**一个人不能用自己的台词作为自己知情的来源**（R1_NO_SELF_ESTABLISH）。
        // 这是 STAGE 那条「同场次后续证据不得回流为前置知识」在本项目里的落地。
        //
        // ⚠️ 严格版（把知情推迟到"他人首次披露场"）实测代价过大：
        // 召回 30%→60%，但误报 3→12、cost 持平 24、精确率 −16.7pp → 被闸门拒绝。
        // 所以这里用**外科版**：不动全局授知，只在「本场内该说法的出现全部来自他自己台词」时
        // 才判定这条在场证据无效。这恰好命中 masked_by_presence 的机制，而不波及其他人。
        if (noSelfEstablish) {
          const sceneObj = byId.get(grantScene);
          if (sceneObj) {
            const surfaces = [...new Set(p.aliases.map((a) => a.surface.replace(/\s+/g, "")))].filter(
              (s) => s.length >= 3,
            );
            const hits = sceneObj.lines.filter((l) => {
              const flat = l.replace(/\s+/g, "");
              return surfaces.some((s) => flat.includes(s));
            });
            const allOwn = hits.length > 0 && hits.every((l) => speakerOf(l) === who);
            if (allOwn) continue; // 本场只有他自己说过 → 这条在场证据无效
          }
        }
        out.push({ character: who, propositionId: p.id, scene });
      }
    }
  }
  return out;
}

/**
 * 把抽取层的 knowledge_deltas 解析到账本命题上。
 *
 * `about` 是「本场原文里指向那件事的片段」。解析方式：在该场里找**拥有这个说法**的账本命题，
 * 若有多个，取匹配片段最长的（越具体越可能是真目标）。
 */
export function buildKnowledge(
  ledger: DraftProposition[],
  sceneExtractions: SceneExtraction[],
): { facts: KnowledgeFact[]; unresolved: Array<{ scene: string; character: string; about: string }> } {
  const facts: KnowledgeFact[] = [];
  const unresolved: Array<{ scene: string; character: string; about: string }> = [];

  for (const se of sceneExtractions) {
    for (const d of se.knowledgeDeltas) {
      const about = d.about.replace(/\s+/g, "");
      let best: { id: string; len: number } | null = null;
      for (const p of ledger) {
        for (const a of p.aliases) {
          if (a.firstSeen !== se.scene) continue; // 只看本场的说法
          const s = a.surface.replace(/\s+/g, "");
          if (s.length < 2) continue;
          if (about.includes(s) || s.includes(about)) {
            if (!best || s.length > best.len) best = { id: p.id, len: s.length };
          }
        }
      }
      if (!best) {
        unresolved.push({ scene: se.scene, character: d.character, about: d.about });
        continue;
      }
      facts.push({
        character: d.character,
        propositionId: best.id,
        scene: se.scene,
        kind: d.kind,
        evidence: d.about,
      });
    }
  }

  return { facts, unresolved };
}

/**
 * 显式记录优先：同一 (角色, 命题) 只要有 `source: "extracted"` 的知情记录，
 * 所有 `default` 推断一律丢弃。
 *
 * 为什么必须这样（实测，见 test-plan.md §5.11）：
 * 林昭的泄漏台词「暗格里那份」出现在 S01-03，抽取把这条命题的 firstSeen 也定在 S01-03，
 * 于是「首见场景在场者得知」顺手把她自己的泄漏变成了她的知识来源 —— 泄漏消失。
 * 而周管在 S02-01 明确告诉过她。**显式证据比默认推断可信**，冲突时以显式为准。
 */
export function reconcileKnowledge(facts: KnowledgeFact[]): KnowledgeFact[] {
  const explicit = new Set(
    facts.filter((f) => f.source !== "default").map((f) => `${f.character}|${f.propositionId}`),
  );
  return facts.filter((f) => f.source !== "default" || !explicit.has(`${f.character}|${f.propositionId}`));
}

/**
 * 把细粒度命题提升成审计单元 —— **R1 的正确运行层面**。
 *
 * 实测依据（test-plan.md §5.11）：同一个「遗嘱在暗格」的事实被抽成了三条命题
 * （E-004/E-005/E-007），告知记录挂在其中一条、使用点在另一条，
 * 于是任何「按命题比对」的判据都永远对不上。知识是关于**那个秘密**的，
 * 使用也是，所以两者都必须在审计单元这一层。
 */
export function liftToUnits(
  ledger: DraftProposition[],
  unitOf: Map<string, string>,
): { units: DraftProposition[]; unitOf: Map<string, string> } {
  const byUnit = new Map<string, DraftProposition>();
  const propToUnit = new Map<string, string>();

  for (const p of ledger) {
    const unit = unitOf.get(p.id) ?? `U-solo-${p.id}`;
    propToUnit.set(p.id, unit);
    const cur = byUnit.get(unit);
    if (!cur) {
      byUnit.set(unit, {
        id: unit,
        canonical: p.canonical,
        aliases: p.aliases.map((a) => ({ ...a })),
        scenes: [...p.scenes],
        agents: [...p.agents],
      });
      continue;
    }
    for (const a of p.aliases) if (!cur.aliases.some((x) => x.surface === a.surface)) cur.aliases.push({ ...a });
    for (const s of p.scenes) if (!cur.scenes.includes(s)) cur.scenes.push(s);
    for (const g of p.agents) if (!cur.agents.includes(g)) cur.agents.push(g);
  }

  return { units: [...byUnit.values()], unitOf: propToUnit };
}

/**
 * 把知识状态与使用点一并提升到单元层，然后跑 R1。
 */
export function auditOnUnits(
  ledger: DraftProposition[],
  usages: Usage[],
  knowledge: KnowledgeFact[],
  sceneOrder: Map<string, number>,
  unitOf: Map<string, string>,
): { issues: LeakIssue[]; units: DraftProposition[] } {
  const { units, unitOf: propToUnit } = liftToUnits(ledger, unitOf);

  const liftedUsages: Usage[] = usages.map((u) => ({
    ...u,
    propositionId: propToUnit.get(u.propositionId) ?? u.propositionId,
  }));

  const lifted: KnowledgeFact[] = knowledge.map((k) => ({
    ...k,
    propositionId: propToUnit.get(k.propositionId) ?? k.propositionId,
  }));

  return {
    issues: detectLeaks(units, liftedUsages, reconcileKnowledge(lifted), sceneOrder),
    units,
  };
}

/**
 * 检测泄漏。
 *
 * 同一条 (角色, 命题) 只报一次 —— 取最早的越界使用，否则一个角色反复提到
 * 同一条不该知道的事会刷出十几条噪音。
 */
export function detectLeaks(
  ledger: DraftProposition[],
  usages: Usage[],
  knowledge: KnowledgeFact[],
  sceneOrder: Map<string, number>,
): LeakIssue[] {
  const byId = new Map(ledger.map((p) => [p.id, p]));
  const known = new Map<string, { scene: string; kind: string }>();
  for (const k of knowledge) {
    const key = `${k.character}|${k.propositionId}`;
    const prev = known.get(key);
    if (!prev || (sceneOrder.get(k.scene) ?? 0) < (sceneOrder.get(prev.scene) ?? 0)) {
      known.set(key, { scene: k.scene, kind: k.kind });
    }
  }

  const issues: LeakIssue[] = [];
  const seen = new Set<string>();

  for (const u of usages) {
    const key = `${u.character}|${u.propositionId}`;
    const k = known.get(key);
    const useIdx = sceneOrder.get(u.scene) ?? 0;
    const knownIdx = k ? (sceneOrder.get(k.scene) ?? 0) : Number.POSITIVE_INFINITY;
    // 得知必须发生在使用之前或同一场（同场得知后用是合法的）
    if (knownIdx <= useIdx) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      character: u.character,
      propositionId: u.propositionId,
      canonical: byId.get(u.propositionId)?.canonical ?? "",
      useScene: u.scene,
      surface: u.surface,
      line: u.line,
      knownAt: k ? k.scene : null,
    });
  }

  // 按场景顺序输出，便于人工核对
  issues.sort((a, b) => (sceneOrder.get(a.useScene) ?? 0) - (sceneOrder.get(b.useScene) ?? 0));
  return issues;
}

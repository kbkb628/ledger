import { appendFileSync } from "node:fs";
import { MERGE_PROPOSITIONS_INSTRUCTIONS } from "../judgment/prompt.js";
import type { JudgmentProvider, JudgmentRequest } from "../judgment/types.js";
import { renderScene, type Scene } from "./script.js";
import { rareTermRecall } from "./recall.js";
import type { DraftProposition, MergeDecision, SceneExtraction, ScenePropositionDraft } from "./types.js";

/**
 * 归并层 —— 把场内抽出的命题跨场归并成账本命题。
 *
 * ## 为什么它必须独立于抽取层（v0 的实测教训）
 *
 * v0 让抽取模型自己决定「这条命题是不是已有那条」，模型就用了**说法相似**：
 * 一条「苏婉让陈默处理掉沈父留下的那份东西」吃掉了六条命题的说法，
 * 因为都含「那份东西」。跨场同一性本质上是**判定任务**，不是抽取任务的副产品。
 *
 * 所以归并复用判定层那条已经验证的路径：
 *   候选召回（blocking）→ JEV 判定（`MERGE_PROPOSITIONS_INSTRUCTIONS`）→ 挂载或新建
 *
 * ## 两个刻意的保守选择
 *
 * 1. **`UNSURE` 与 `NEW` 一样新建命题。** 错分（两条变一条）会让账本**系统性失真**，
 *    而错并的反面（一条变两条）只是候选集变大 —— 后者可修，前者会静默污染所有判断。
 * 2. **零候选时不调用判定器**，直接新建。省掉一次调用，也避免模型在空候选里硬选。
 *
 * ## 与设计文档的一处偏差（待验证）
 *
 * `design.md` 的三层路由里，第 1 层是**结构匹配**（用 type/agent/patient 相等直接并），
 * 第 2 层才是 JEV。但 P1-2 消融证明这些结构化字段对判定零贡献，
 * 而 v1 抽取层按最小范围**没有抽它们** —— 所以第 1 层暂时是空的，
 * 直接走「bigram blocking → JEV」。**这是已知的待验证缺口，不是遗漏。**
 */

export interface MergeOptions {
  provider: JudgmentProvider;
  /** blocking 取前 K 条候选，默认 6 */
  topK?: number;
  /** blocking 相似度下限，默认 0.15 */
  minScore?: number;
  /** 增量并入时的起点（见 `seed`） */
  seed?: DraftProposition[];
  /**
   * 文本归一化 —— 目前用于**人物别称归一**（沈父 / 林昭的父亲 / 老爷 → 同一个名字）。
   *
   * 实测驱动（test-plan.md §5.12）：归并判据要求「施事对得上」，
   * 而同一人物的不同称呼在字面上是两个施事，于是同一事实被判了三次 NEW。
   * 归一化只作用在**比较与判定的输入**上，落盘的 canonical 保留原文措辞。
   */
  normalize?: (s: string) => string;
  /**
   * 人物别称表，作为**参考信息**附在归并指令后面。
   *
   * 为什么不做字符串替换（实测教训，test-plan.md §5.12）：
   * 把「父亲」替换成「沈父」会把「林昭的父亲」变成「林昭的沈父」——
   * 字面替换制造出的新字符串比原文更像噪声。
   * 判据是「施事对得上」，这需要**理解**「林昭的父亲就是沈父」，不是替换。
   */
  characterHint?: string;
  verbose?: boolean;
}

export interface MergeResult {
  propositions: DraftProposition[];
  decisions: MergeDecision[];
  costUsd: number;
  latencyMs: number;
  calls: number;
  /** 被判定器拒绝作答的次数（按保守策略已新建命题） */
  unsure: number;
}

const STRIP = /[\s。，、！？：；「」（）·—…"'']/g;

function bigrams(s: string): Set<string> {
  const t = s.replace(STRIP, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return (2 * hit) / (a.size + b.size);
}

/** 一条命题用于 blocking 的全部文本 */
function propText(canonical: string, surfaces: string[]): string {
  return [canonical, ...surfaces].join(" ");
}

export async function mergeScenes(
  sceneExtractions: SceneExtraction[],
  scenes: Scene[],
  opts: MergeOptions,
): Promise<MergeResult> {
  const topK = opts.topK ?? Number(process.env.MERGE_TOPK ?? 6);
  const minScore = opts.minScore ?? Number(process.env.MERGE_MIN_SCORE ?? 0.15);
  const norm = opts.normalize ?? ((s: string) => s);

  const propositions: DraftProposition[] = (opts.seed ?? []).map((p) => ({
    ...p,
    aliases: p.aliases.map((a) => ({ ...a })),
    scenes: [...p.scenes],
    agents: [...p.agents],
  }));
  const decisions: MergeDecision[] = [];
  let costUsd = 0;
  let calls = 0;
  let unsure = 0;
  // 接着已有账本的 id 继续编，避免与冻结的 id 撞车
  let nextId =
    propositions.reduce((max, p) => {
      const m = /^E-(\d+)$/.exec(p.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
  const started = Date.now();
  // 召回层轨迹：`R1_MERGE_TRACE=<file>` 时旁记每个 draft 的候选表（不参与决策）
  const tracePath = process.env.R1_MERGE_TRACE || "";
  const traceRows: Array<{ scene: string; canonical: string; surfaces: string[]; candidates: string[]; choice: string; createdId?: string | null; reason: string }> | null =
    tracePath ? [] : null;

  for (const se of sceneExtractions) {
    const scene = scenes.find((s) => s.id === se.scene) ?? { id: se.scene, meta: [], lines: [] };
    const sceneText = renderScene(scene);

    for (const draft of se.propositions) {
      const draftText = norm(propText(draft.canonical, draft.surfaces.map((s) => s.text)));
      // 施事名字也归一 —— 否则「施事知道自己做的事」这条规则会因为别称对不上而失效
      const draftAgents = draft.agents.map(norm);

      // ── blocking：用字符 bigram 相似度召回候选（在归一化后的文本上） ──
      const scored = propositions
        .map((p) => ({
          p,
          score: dice(bigrams(draftText), bigrams(norm(propText(p.canonical, p.aliases.map((a) => a.surface))))),
        }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      // ── 罕见词召回（`R1_MERGE_RECALL=1`）：补上 bigram-Dice 够不着的候选 ──
      //
      // 机制：「换了说法」的两句，Dice 往往 < 0.15，判官连看都看不到 → 新建命题 →
      // 首见场景在场者当场获得许可（幻影集量到的正是这条）。但两句常共享一个**稀有词**
      // （「密码」「井」「血型」…），它在账本里只属于一条命题 —— 那就该把那条命题端给判官。
      //
      // 只在「候选稀薄」时触发会更省（回合 51 试过：花费只降 13%，召回还掉 1 条）——
      // 所以默认全量补，`R1_RECALL_TRIGGER` 只留作敏感性开关。
      const trigger = Number(process.env.R1_RECALL_TRIGGER ?? 1);
      const thin = scored.length === 0 || (scored[0]?.score ?? 0) < trigger;
      // 召回通道给出的「共享稀有词」，**默认不**随候选交给判官。
      // 回合 56 实测：加上以后候选召回不变（27/51），挂载反而从 11/27 掉到 9/27 —— 否掉了。
      // 保留开关只为复核（依据 design.md §6.3.1，字面线索本该有用，但「共享词」这种提示
      // 显然不是判官需要的形态：它要的是**原话**，而不是我们替它提炼的词）。
      const recallHint = new Map<string, string[]>();
      if (process.env.R1_MERGE_RECALL === "1" && thin) {
        const extra = rareTermRecall({
          text: draftText,
          props: propositions.map((p) => ({
            id: p.id,
            text: norm(propText(p.canonical, p.aliases.map((a) => a.surface))),
          })),
          minIdf: Number(process.env.R1_RECALL_MIN_IDF ?? 1.2),
          topK: Number(process.env.R1_RECALL_TOPK ?? 4),
        });
        const have = new Set(scored.map((x) => x.p.id));
        for (const hit of extra) {
          if (process.env.R1_RECALL_HINT === "1") recallHint.set(hit.id, hit.shared);
          if (have.has(hit.id)) continue;
          const p = propositions.find((x) => x.id === hit.id);
          if (p) scored.push({ p, score: 0 });
        }
        if (opts.verbose && extra.length) {
          process.stdout.write(`    ${se.scene} 罕见词召回 +${extra.length}（${extra.map((h) => h.id).join("/")}）\n`);
        }
      }

      if (scored.length === 0) {
        decisions.push({
          scene: se.scene, canonical: draft.canonical, choice: "NEW",
          candidates: [], confidence: 1, reason: "no_candidate",
        });
        const newId = `E-${String(nextId++).padStart(3, "0")}`;
        propositions.push(newProposition(newId, { ...draft, agents: draftAgents }, se.scene));
        // 「一条候选都没有」正是召回层失败的那一类，必须进轨迹 ——
        // 否则轨迹只统计到成功召回的那些，召回率会被系统性高估。
        if (traceRows) {
          traceRows.push({
            scene: se.scene,
            canonical: draft.canonical,
            surfaces: draft.surfaces.map((s) => s.text),
            candidates: [],
            choice: "NEW",
            createdId: newId,
            reason: "no_candidate",
          });
        }
        continue;
      }

      const candidates = scored.map((x) => x.p);

      // ── 同说法优先归并（`R1_MERGE_EXACT=1`）──
      //
      // 机制：别名表的本意就是「同一件事被不同措辞提到」，可**逐字相同的说法**
      // 在同一个账本里指向两件事的概率，比模型误判的概率低得多。
      // 而一旦被误判成 NEW，新命题的首见场景 = 泄漏现场，于是
      // 「首见场景在场者得知」当场给泄漏者发许可 —— 这就是 `masked_by_presence`
      // 在归并层的根因（回合 30：10 条漏报里 8 条命中、7 条同一机制；5 条误报里 4 条同源）。
      //
      // 只在**唯一命中**时短路判官：若同一说法已经挂在多条命题上（「那份东西」这类），
      // 说明它不具区分度，仍交给判官裁决。
      const exact = exactSurfaceMatches(draft, propositions, norm);
      if (exact.length === 1) {
        attach(propositions, exact[0]!, draft, draftAgents, se.scene, false);
        if (opts.verbose) {
          process.stdout.write(`    ${se.scene} 「${draft.canonical.slice(0, 26)}」→ ${exact[0]!.id} (exact_surface)\n`);
        }
        decisions.push({
          scene: se.scene, canonical: draft.canonical, choice: exact[0]!.id,
          candidates: candidates.map((p) => p.id), confidence: 1, reason: "exact_surface",
        });
        continue;
      }
      if (exact.length > 1 && opts.verbose) {
        process.stdout.write(`    ${se.scene} 同说法命中 ${exact.length} 条（${exact.map((p) => p.id).join("/")}）→ 交判官\n`);
      }

      // ── 长重合优先归并（`R1_MERGE_OVERLAP`，默认开启，`=0` 回退）──
      //
      // 为什么还要一层：回合 36 的幻影集显示，**即使逐字一致，归并也只有一半挂上**
      // （anchored 4/8）。原因是别名存的是**整句台词**，"保险箱的密码是小姐的生日，
      // 老爷只告诉我一个人。" 与 "保险箱的密码是小姐的生日，改不改都没意义。" 逐字比对
      // 不相等，判官又可能判 NEW —— 于是同一事实变成两条命题，泄漏现场那条又靠
      // 在场者得知给自己发了许可。
      //
      // 判据仍是**确定性**的：两条说法共享一段 ≥N 字的连续片段（默认 6，即两个词量级），
      // 且这样的命题**唯一**时才短路判官。唯一性要求是关键 ——
      // 「那份东西」这类泛指的共享片段会命中多条，仍然交判官。
      const overlap = overlapSurfaceMatches(draft, propositions, norm);
      if (overlap.length === 1) {
        attach(propositions, overlap[0]!, draft, draftAgents, se.scene, false);
        if (opts.verbose) {
          process.stdout.write(`    ${se.scene} 「${draft.canonical.slice(0, 26)}」→ ${overlap[0]!.id} (overlap_surface)\n`);
        }
        decisions.push({
          scene: se.scene, canonical: draft.canonical, choice: overlap[0]!.id,
          candidates: candidates.map((p) => p.id), confidence: 1, reason: "overlap_surface",
        });
        continue;
      }
      if (overlap.length > 1 && opts.verbose) {
        process.stdout.write(`    ${se.scene} 长重合命中 ${overlap.length} 条（${overlap.map((p) => p.id).join("/")}）→ 交判官\n`);
      }
      const req: JudgmentRequest = {
        task: "bind_mention",
        mention: {
          surface: draft.canonical,
          scene: se.scene,
          // 上下文给整场：P1-1 实测上下文加宽是最大的一块提升，归并同样需要
          context: sceneText,
          kind: "repeated_surface",
        },
        instructions: opts.characterHint
          ? `${MERGE_PROPOSITIONS_INSTRUCTIONS}\n\n【人物别称】以下称呼指同一个人，判「施事是否对得上」时按同一人处理：\n${opts.characterHint}`
          : MERGE_PROPOSITIONS_INSTRUCTIONS,
        candidates: candidates.map((p) => ({
          id: p.id,
          canonical: p.canonical,
          keywords: [
            ...p.aliases.map((a) => a.surface),
            // 召回通道给出的共享稀有词：作为**字面线索**随候选呈现给判官
            ...(recallHint.get(p.id) ?? []).map((tok) => `与本句共享：${tok}`),
          ],
          type: "",
        })),
        allowedChoices: [...candidates.map((p) => p.id), "NEW", "UNSURE"],
      };

      let choice = "NEW";
      let confidence = 0;
      let reason: MergeDecision["reason"] = "new";
      try {
        const r = await opts.provider.judge(req);
        costUsd += r.costUsd;
        calls += 1;
        choice = r.choice;
        confidence = r.confidence;
        if (choice === "UNSURE") { unsure += 1; reason = "unsure"; }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.verbose) process.stdout.write(`    归并调用失败：${message.slice(0, 90)}\n`);
        reason = "new";
      }

      let createdId: string | null = null;
      const target = propositions.find((p) => p.id === choice);
      if (target) {
        reason = "attached";
        attach(propositions, target, draft, draftAgents, se.scene, opts.verbose, confidence);
      } else {
        createdId = `E-${String(nextId++).padStart(3, "0")}`;
        propositions.push(newProposition(createdId, { ...draft, agents: draftAgents }, se.scene));
        if (opts.verbose) {
          process.stdout.write(`    ${se.scene} 「${draft.canonical.slice(0, 26)}」→ NEW (${choice}, ${confidence.toFixed(2)})\n`);
        }
      }

      decisions.push({
        scene: se.scene, canonical: draft.canonical, choice,
        candidates: candidates.map((p) => p.id), confidence, reason,
        // 召回层轨迹（`R1_MERGE_TRACE=<file>`）：只读式的旁记，不参与任何决策。
        // 目的：把「候选有没有被召回」从判定层的噪声里剥出来，做成确定性指标 ——
        // 否则每次改动都要靠 McNemar 在 p≈0.1 附近打转（回合 51/53）。
        ...(traceRows ? { surfaces: draft.surfaces.map((s) => s.text) } : {}),
      });
      if (traceRows) {
        traceRows.push({
          scene: se.scene,
          canonical: draft.canonical,
          surfaces: draft.surfaces.map((s) => s.text),
          candidates: candidates.map((p) => p.id),
          choice,
          createdId,
          reason,
        });
      }
    }
  }

  // 兜底：从未被标记为「确立」的命题退回首见场 —— 不额外制造知识，也不静默丢知识
  for (const p of propositions) if (p.establishedAt === undefined) p.establishedAt = p.scenes[0] ?? null;

  if (traceRows) {
    // 追加而不是覆盖：一次运行里 mergeScenes 可能被调用多次（分块建账），
    // 覆盖只会留下最后一块的轨迹 —— 那正是第一次跑出「65 条轨迹」的原因。
    appendFileSync(tracePath!, traceRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  return { propositions, decisions, costUsd, latencyMs: Date.now() - started, calls, unsure };
}

/** 归并结果挂到目标命题上（新增说法 / 施事 / 场次 / 确立场次） */
function attach(
  propositions: DraftProposition[],
  target: DraftProposition,
  draft: ScenePropositionDraft,
  draftAgents: string[],
  scene: string,
  verbose?: boolean,
  confidence = 1,
): void {
  void propositions;
  for (const s of draft.surfaces) {
    if (!target.aliases.some((a) => a.surface === s.text)) {
      target.aliases.push({ surface: s.text, firstSeen: scene, kind: s.kind });
    }
  }
  for (const a of draftAgents) if (!target.agents.includes(a)) target.agents.push(a);
  if (!target.scenes.includes(scene)) target.scenes.push(scene);
  // 首次「确立」的场次 —— R1 的在场者规则只从这里起算（见 rsi-protocol 第 9 回合）
  if (draft.established !== false && (target.establishedAt === undefined || target.establishedAt === null)) {
    target.establishedAt = scene;
  }
  if (verbose) {
    process.stdout.write(`    ${scene} 「${draft.canonical.slice(0, 26)}」→ ${target.id} (${confidence.toFixed(2)})\n`);
  }
}

/**
 * 逐字相同的说法命中了几条命题。
 *
 * 门槛 `≥4` 个归一化字符：`R1_MIN_SURFACE_LEN` 的下限是 3，
 * 而 3 字说法（「那份东西」只有 4 字但极泛）在账本里本就歧义，
 * 交给判官更安全。命中 ≥2 条时调用方也**不会**短路，仍走判官。
 */
function exactSurfaceMatches(
  draft: ScenePropositionDraft,
  propositions: DraftProposition[],
  norm: (s: string) => string,
): DraftProposition[] {
  if (process.env.R1_MERGE_EXACT !== "1") return [];
  const wanted = new Set(draft.surfaces.map((s) => norm(s.text)).filter((s) => s.length >= 4));
  if (wanted.size === 0) return [];
  return propositions.filter((p) => p.aliases.some((a) => wanted.has(norm(a.surface))));
}

/**
 * 说法之间的**最长公共连续片段**长度 —— 归并层的确定性线索。
 *
 * 为什么不用编辑距离：别名是整句台词，长短不一，编辑距离会被长度差主导；
 * 而「同一事实的两种说法」几乎必然共享一段实词片段（「保险箱的密码」「出境记录有两笔」）。
 */
function longestCommonSpan(a: string, b: string): number {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1]! + 1 : 0;
      if (cur[j]! > best) best = cur[j]!;
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return best;
}

/**
 * 长重合命中了哪几条命题（`R1_MERGE_OVERLAP`）。
 *
 * **已基线化（回合 38）**：默认开启，`=0` 是回退开关。
 * 依据是茶馆那份冻结抽取上的 A/B（同 provider、只重跑归并）——
 * 问题清单 4 条 → 3 条，命题 264 → 256，没有越过「+2 条即回退」的红线。
 *
 * 门槛默认 6 个归一化字符：3–4 字（「那份东西」「密码」）在账本里本就泛指，
 * 共享它不构成「同一件事」的证据；6 字约等于两个实词。
 * `R1_MERGE_OVERLAP_MIN` 可调，用于敏感性检查（不要事后按结果挑一个）。
 */
function overlapSurfaceMatches(
  draft: ScenePropositionDraft,
  propositions: DraftProposition[],
  norm: (s: string) => string,
): DraftProposition[] {
  if (process.env.R1_MERGE_OVERLAP === "0") return [];
  const minSpan = Number(process.env.R1_MERGE_OVERLAP_MIN ?? 6);
  const wanted = draft.surfaces.map((s) => norm(s.text)).filter((s) => s.length >= minSpan);
  if (wanted.length === 0) return [];
  return propositions.filter((p) =>
    p.aliases.some((a) => {
      const target = norm(a.surface);
      if (target.length < minSpan) return false;
      return wanted.some((w) => longestCommonSpan(w, target) >= minSpan);
    }),
  );
}

function newProposition(id: string, draft: ScenePropositionDraft, scene: string): DraftProposition {  return {
    id,
    canonical: draft.canonical,
    aliases: draft.surfaces.map((s) => ({ surface: s.text, firstSeen: scene, kind: s.kind })),
    scenes: [scene],
    agents: [...draft.agents],
    establishedAt: draft.established === false ? null : scene,
  };
}

import { MERGE_PROPOSITIONS_INSTRUCTIONS } from "../judgment/prompt.js";
import type { JudgmentProvider, JudgmentRequest } from "../judgment/types.js";
import { renderScene, type Scene } from "./script.js";
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

      if (scored.length === 0) {
        decisions.push({
          scene: se.scene, canonical: draft.canonical, choice: "NEW",
          candidates: [], confidence: 1, reason: "no_candidate",
        });
        propositions.push(newProposition(`E-${String(nextId++).padStart(3, "0")}`, { ...draft, agents: draftAgents }, se.scene));
        continue;
      }

      const candidates = scored.map((x) => x.p);
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
          keywords: p.aliases.map((a) => a.surface),
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

      const target = propositions.find((p) => p.id === choice);
      if (target) {
        reason = "attached";
        for (const s of draft.surfaces) {
          if (!target.aliases.some((a) => a.surface === s.text)) {
            target.aliases.push({ surface: s.text, firstSeen: se.scene, kind: s.kind });
          }
        }
        for (const a of draftAgents) if (!target.agents.includes(a)) target.agents.push(a);
        if (!target.scenes.includes(se.scene)) target.scenes.push(se.scene);
        // 首次「确立」的场次 —— R1 的在场者规则只从这里起算（见 rsi-protocol 第 9 回合）
        if (draft.established !== false && (target.establishedAt === undefined || target.establishedAt === null)) {
          target.establishedAt = se.scene;
        }
        if (opts.verbose) {
          process.stdout.write(`    ${se.scene} 「${draft.canonical.slice(0, 26)}」→ ${target.id} (${confidence.toFixed(2)})\n`);
        }
      } else {
        propositions.push(newProposition(`E-${String(nextId++).padStart(3, "0")}`, { ...draft, agents: draftAgents }, se.scene));
        if (opts.verbose) {
          process.stdout.write(`    ${se.scene} 「${draft.canonical.slice(0, 26)}」→ NEW (${choice}, ${confidence.toFixed(2)})\n`);
        }
      }

      decisions.push({
        scene: se.scene, canonical: draft.canonical, choice,
        candidates: candidates.map((p) => p.id), confidence, reason,
      });
    }
  }

  // 兜底：从未被标记为「确立」的命题退回首见场 —— 不额外制造知识，也不静默丢知识
  for (const p of propositions) if (p.establishedAt === undefined) p.establishedAt = p.scenes[0] ?? null;

  return { propositions, decisions, costUsd, latencyMs: Date.now() - started, calls, unsure };
}

function newProposition(id: string, draft: ScenePropositionDraft, scene: string): DraftProposition {
  return {
    id,
    canonical: draft.canonical,
    aliases: draft.surfaces.map((s) => ({ surface: s.text, firstSeen: scene, kind: s.kind })),
    scenes: [scene],
    agents: [...draft.agents],
    establishedAt: draft.established === false ? null : scene,
  };
}

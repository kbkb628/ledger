import { fetchWithTimeout } from "../util/http.js";
import { renderExtractionPrompt } from "./prompt.js";
import { renderScene, type Scene } from "./script.js";
import type {
  ExtractedSurface,
  KnowledgeDelta,
  ReferenceKind,
  SceneExtraction,
  ScenePropositionDraft,
} from "./types.js";

/**
 * 场内抽取器 v1 —— 把每一场剧本变成「命题 + 说法」，**不做任何跨场归并**。
 *
 * 归并见 `merge.ts`。这里只负责第 0 层：
 *
 *   剧本一场 → [{ canonical, surfaces: [{text, kind}] }]
 *
 * ## 为什么逐场、而不是整本一次
 *
 * 1. 产品必须支持**增量**（剧在写，账本要跟着长）—— 逐场是产品的真实工作方式。
 * 2. 整本一次会让「首见场景」不可判定，而 `first_seen` 是时序过滤的基础。
 * 3. 长上下文会让后面场次的判断掺进前面场次的结果，污染实验（rsi-log 效度教训 1）。
 *
 * ## 代码侧的两道校验（不信任模型的自觉）
 *
 * 1. **说法必须原文可查**：不在本场原文里的 surface 一律丢弃并计数。
 *    这是 rsi-log「手写关键词」教训的机械化防线。
 * 2. **kind 必须合法**：非法值降级为 `descriptive`（保守 —— 它不参与「泛化指代」的特殊处理）。
 */

export interface ExtractOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  thinking?: string;
  /** 逐场打印进度 */
  verbose?: boolean;
}

export interface ExtractResult {
  scenes: SceneExtraction[];
  costUsd: number;
  latencyMs: number;
  calls: number;
  failures: Array<{ scene: string; error: string }>;
  /** 被「原文可查」校验拦掉的说法数 */
  rejectedSurfaces: number;
  /** 各 kind 的计数，用于确认模型真的在区分指称类型 */
  kindCounts: Record<ReferenceKind, number>;
  /** knowledge_delta 总数 */
  knowledgeDeltas: number;
  /** 被「原文可查」校验拦掉的知识变化数 */
  rejectedDeltas: number;
}

export async function extractScenes(scenes: Scene[], opts: ExtractOptions = {}): Promise<ExtractResult> {
  const baseUrl = (opts.baseUrl ?? process.env.EXTRACT_BASE_URL ?? process.env.JUDGE_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.EXTRACT_API_KEY ?? process.env.JUDGE_API_KEY ?? "";
  const model = opts.model ?? process.env.EXTRACT_MODEL ?? process.env.JUDGE_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) {
    throw new Error("缺少抽取服务配置。请设置 JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL（或 EXTRACT_* 覆盖）");
  }
  const temperature = opts.temperature ?? Number(process.env.EXTRACT_TEMPERATURE ?? 0);
  const thinking = opts.thinking ?? process.env.EXTRACT_THINKING?.trim() ?? process.env.JUDGE_THINKING?.trim();
  const priceIn = Number(process.env.JUDGE_PRICE_IN ?? 0);
  const priceOut = Number(process.env.JUDGE_PRICE_OUT ?? 0);

  const out: SceneExtraction[] = [];
  const failures: Array<{ scene: string; error: string }> = [];
  const kindCounts: Record<ReferenceKind, number> = { explicit: 0, descriptive: 0, vague: 0 };
  let costUsd = 0;
  let calls = 0;
  let rejectedSurfaces = 0;
  let knowledgeDeltas = 0;
  let rejectedDeltas = 0;
  const started = Date.now();

  for (const scene of scenes) {
    const sceneText = renderScene(scene);
    let parsed: { propositions: ScenePropositionDraft[]; deltas: KnowledgeDelta[] };
    try {
      const r = await callExtractor({
        baseUrl, apiKey, model, temperature, thinking, priceIn, priceOut,
        prompt: renderExtractionPrompt(scene, sceneText),
      });
      costUsd += r.costUsd;
      calls += 1;
      parsed = r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ scene: scene.id, error: message });
      if (opts.verbose) process.stdout.write(`  ${scene.id} ✗ ${message.slice(0, 100)}\n`);
      continue;
    }

    const kept: ScenePropositionDraft[] = [];
    for (const d of parsed.propositions) {
      const surfaces: ExtractedSurface[] = [];
      for (const s of d.surfaces) {
        if (!appearsIn(s.text, sceneText)) {
          rejectedSurfaces += 1;
          continue;
        }
        surfaces.push(s);
        kindCounts[s.kind] += 1;
      }
      if (!d.canonical.trim() && surfaces.length === 0) continue;
      kept.push({
        canonical: d.canonical.trim() || surfaces[0]!.text,
        surfaces,
        agents: d.agents.filter((a) => sceneText.includes(a)), // 人名也要原文可查
      established: d.established,
      });
    }

    // 知识变化同样要过「原文可查」—— about 必须是本场原文里能指向那件事的片段
    const deltas: KnowledgeDelta[] = [];
    for (const k of parsed.deltas) {
      if (!k.character.trim() || !appearsIn(k.about, sceneText)) {
        rejectedDeltas += 1;
        continue;
      }
      deltas.push({ character: k.character.trim(), about: k.about, kind: k.kind });
      knowledgeDeltas += 1;
    }

    out.push({ scene: scene.id, propositions: kept, knowledgeDeltas: deltas });
    if (opts.verbose) {
      process.stdout.write(
        `  ${scene.id} → ${kept.length} 条命题 / ${kept.reduce((a, p) => a + p.surfaces.length, 0)} 条说法` +
          ` / ${deltas.length} 条知识变化\n`,
      );
    }
  }

  return {
    scenes: out,
    costUsd,
    latencyMs: Date.now() - started,
    calls,
    failures,
    rejectedSurfaces,
    kindCounts,
    knowledgeDeltas,
    rejectedDeltas,
  };
}

/** 原文可查：先直接子串匹配，再去掉所有空白后匹配（容忍换行/空格差异）。 */
export function appearsIn(surface: string, text: string): boolean {
  const s = surface.trim();
  if (!s) return false;
  if (text.includes(s)) return true;
  const strip = (x: string) => x.replace(/\s+/g, "");
  return strip(text).includes(strip(s));
}

interface CallArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  thinking?: string;
  prompt: string;
  priceIn: number;
  priceOut: number;
}

async function callExtractor(
  a: CallArgs,
): Promise<{ propositions: ScenePropositionDraft[]; deltas: KnowledgeDelta[]; costUsd: number }> {
  const res = await fetchWithTimeout(`${a.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.apiKey}` },
    body: JSON.stringify({
      model: a.model,
      messages: [{ role: "user", content: a.prompt }],
      response_format: { type: "json_object" },
      temperature: a.temperature,
      ...(a.thinking ? { thinking: { type: a.thinking } } : {}),
    }),
  }, "抽取");

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`抽取服务返回 ${res.status}：${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = payload.choices?.[0]?.message?.content ?? "";
  const costUsd =
    ((payload.usage?.prompt_tokens ?? 0) / 1e6) * a.priceIn +
    ((payload.usage?.completion_tokens ?? 0) / 1e6) * a.priceOut;

  return { ...parseExtraction(text), costUsd };
}

/** 宽容解析：兼容 markdown 包裹、字段缺失、surfaces 写成裸字符串、kind 缺失或非法。 */
export function parseExtraction(text: string): {
  propositions: ScenePropositionDraft[];
  deltas: KnowledgeDelta[];
} {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`抽取输出不是 json：${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }

  const rec = obj as { propositions?: unknown; knowledge_deltas?: unknown };
  const list = Array.isArray(rec.propositions) ? rec.propositions : [];
  const propositions: ScenePropositionDraft[] = [];

  for (const item of list) {
    const r = item as { canonical?: unknown; surfaces?: unknown; agents?: unknown; established?: unknown };
    propositions.push({
      canonical: typeof r.canonical === "string" ? r.canonical : "",
      surfaces: parseSurfaces(r.surfaces),
      // 缺省 true：旧行为（把首见当确立）
      established: r.established === undefined ? true : Boolean(r.established),
      agents: Array.isArray(r.agents)
        ? r.agents.map((a) => String(a).trim()).filter(Boolean)
        : typeof r.agents === "string" && r.agents.trim()
          ? [r.agents.trim()]
          : [],
    });
  }

  return { propositions, deltas: parseDeltas(rec.knowledge_deltas) };
}

function parseDeltas(raw: unknown): KnowledgeDelta[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: KnowledgeDelta[] = [];
  for (const it of list) {
    const o = it as { character?: unknown; about?: unknown; kind?: unknown };
    const character = String(o.character ?? "").trim();
    const about = String(o.about ?? "").trim();
    if (!character || !about) continue;
    const k = String(o.kind ?? "").trim();
    out.push({
      character,
      about,
      kind: k === "learns_false" || k === "suspects" ? k : "learns",
    });
  }
  return out;
}

function parseSurfaces(raw: unknown): ExtractedSurface[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : [];
  const out: ExtractedSurface[] = [];
  for (const it of items) {
    if (typeof it === "string") {
      if (it.trim()) out.push({ text: it, kind: "descriptive" });
      continue;
    }
    const o = it as { text?: unknown; surface?: unknown; kind?: unknown };
    const text = String(o.text ?? o.surface ?? "").trim();
    if (!text) continue;
    out.push({ text, kind: normalizeKind(o.kind) });
  }
  return out;
}

/** 非法 kind 降级为 descriptive（保守：不会被当成「泛化指代」特殊处理） */
function normalizeKind(raw: unknown): ReferenceKind {
  const k = String(raw ?? "").trim().toLowerCase();
  return k === "explicit" || k === "vague" || k === "descriptive" ? k : "descriptive";
}

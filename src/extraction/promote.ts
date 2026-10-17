import { fetchWithTimeout } from "../util/http.js";
import type { DraftProposition } from "./types.js";

/**
 * Promotion 层 —— 把「客观事实」提升成「审计单元」。
 *
 * ## 为什么需要它（设计里原本没有这一层）
 *
 * 抽取层产出的是细粒度事实：
 *
 *   E-001 苏婉伪造了沈父的遗嘱
 *   E-014 苏婉让陈默修改了沈父的遗嘱
 *   E-017 陈默一直保留着某份原件
 *
 * R1 问的是「角色 A 用了还不该知道的信息吗」。若按细事实报，一个秘密会被报成
 * 三条问题（「他不知道苏婉伪造了遗嘱」「他不知道苏婉让陈默改遗嘱」……）——
 * 用户看到的是噪声；而依赖图也不该有「陆见深站在岸边」这种节点。
 *
 * 所以需要一层把细事实归并成「**同一个秘密**」：
 *
 *        ↓ promote
 *   「遗嘱被篡改」  ← 审计单元：谁不知道这件事
 *
 * ## 为什么不做成判定（JEV）而是一次聚类
 *
 * 第 1/2 层问的是「这两条是不是**同一件事**」——局部、两两可判。
 * promotion 问的是「这几条是不是**同一个秘密**」——这需要**全剧语境**
 * （谁在什么时候可能知道哪一部分），两两判定会丢掉全局信息。
 *
 * 代价是它不可增量：账本一变就要重算。当前规模（几十条命题）一次调用足够便宜。
 *
 * ## 判据的把握度
 *
 * 「同一个秘密」本身有边界模糊之处（「苏婉伪造遗嘱」与「苏婉调换遗嘱」是同一行为两面，
 * 但「苏婉篡改遗嘱」与「苏婉命令烧掉遗嘱」是两个不同的秘密）。所以指令里
 * **明确给出该并与不该并的例子**，并且要求「单独成组很正常，不要为了凑组而合并」。
 */

export interface PromoteOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  thinking?: string;
  verbose?: boolean;
}

export interface PromoteResult {
  /** 命题 id → 审计单元 id（形如 U-01） */
  unitOf: Map<string, string>;
  /** 每个审计单元包含的命题 id */
  clusters: Array<{ unit: string; label: string; members: string[] }>;
  costUsd: number;
  latencyMs: number;
  /** 模型漏掉的命题（本地补成单元素组） */
  missed: string[];
  /** 模型重复分组的命题 */
  duplicated: string[];
}

export const PROMOTE_INSTRUCTIONS = `下面是一个短剧账本里的命题清单。每条命题是一个「客观事实」。

请把它们按「**同一个秘密**」分组：同一组里的命题，是**同一桩事的不同侧面**，
也就是「某个角色可以知道或不知道」的同一个整体。

## 该并（同一组）
- 同一次行为的不同侧面：「苏婉伪造了遗嘱」与「苏婉调换了遗嘱」
- 同一桩事的不同环节：「苏婉指使陈默改遗嘱」与「陈默经手改遗嘱」
- 同一个物件的相关的同一件事：「沈父立过遗嘱」与「苏婉篡改了遗嘱」

## 不该并（不同组）
- 施事不同、且可被知道的时机不同：「苏婉伪造遗嘱」与「陈默私藏原件」
- 行为不同、后果不同：「苏婉篡改遗嘱」与「苏婉命令烧掉遗嘱」（前者是改动，后者是销毁）
- 只是碰巧涉及同一个人或同一个物件：「苏婉篡改遗嘱」与「苏婉转走两千三百万」
- 当事人与旁证：「陆见深在码头没有施救」与「陆见深不施救是为了保住沈知微」

**「同一个物件」或「同一个人」不构成同组理由。** 例如下面五条都在讲「遗嘱」，
但它们是**五个不同的秘密**，必须分开：
- 沈父生前立过遗嘱（这件事存在）
- 苏婉伪造 / 篡改了遗嘱（谁在什么时候动了它）
- 真正的遗嘱藏在怀表里（它现在在哪）
- 苏婉下令烧掉遗嘱（有人想让它消失）
- 沈父临终告诉过某人怀表的事（谁被告知了什么）

判据仍然是：**「知道 A 却不知道 B」是否可能且合理**。可能是，就要分开。

**单独成组的命题很正常。不要为了凑组而合并 —— 错并会让用户漏看真正的问题。**

## 输出
只输出 json，不要任何解释或代码块：
{"groups":[{"label":"<这组秘密的短标签，6 字以内>","members":["E-001","E-003"]}]}

要求：清单里的**每个命题必须恰好出现在一组里**，不得遗漏、不得重复。`;

export async function promoteUnits(
  propositions: DraftProposition[],
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const baseUrl = (opts.baseUrl ?? process.env.EXTRACT_BASE_URL ?? process.env.JUDGE_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.EXTRACT_API_KEY ?? process.env.JUDGE_API_KEY ?? "";
  const model = opts.model ?? process.env.EXTRACT_MODEL ?? process.env.JUDGE_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) throw new Error("缺少 promotion 所需的模型配置");
  const temperature = opts.temperature ?? Number(process.env.EXTRACT_TEMPERATURE ?? 0);
  const thinking = opts.thinking ?? process.env.EXTRACT_THINKING?.trim();
  const priceIn = Number(process.env.JUDGE_PRICE_IN ?? 0);
  const priceOut = Number(process.env.JUDGE_PRICE_OUT ?? 0);

  const listing = propositions.map((p) => `- ${p.id}：${p.canonical}`).join("\n");
  const prompt = `${PROMOTE_INSTRUCTIONS}

---

【命题清单】
${listing}`;

  const started = Date.now();
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature,
      ...(thinking ? { thinking: { type: thinking } } : {}),
    }),
  }, "promotion");
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`promotion 服务返回 ${res.status}：${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const costUsd =
    ((payload.usage?.prompt_tokens ?? 0) / 1e6) * priceIn +
    ((payload.usage?.completion_tokens ?? 0) / 1e6) * priceOut;

  const text = payload.choices?.[0]?.message?.content ?? "";
  const groups = parseGroups(text);

  // ── 本地兜底：模型漏掉/重复的命题必须被收拾干净，否则账本会静默丢命题 ──
  const valid = new Set(propositions.map((p) => p.id));
  const seen = new Set<string>();
  const unitOf = new Map<string, string>();
  const clusters: PromoteResult["clusters"] = [];
  const duplicated: string[] = [];
  let n = 1;

  for (const g of groups) {
    const members = g.members.filter((id) => {
      if (!valid.has(id)) return false;
      if (seen.has(id)) { duplicated.push(id); return false; }
      return true;
    });
    if (members.length === 0) continue;
    const unit = `U-${String(n++).padStart(2, "0")}`;
    for (const id of members) { seen.add(id); unitOf.set(id, unit); }
    clusters.push({ unit, label: g.label || unit, members });
  }

  const missed = propositions.filter((p) => !seen.has(p.id)).map((p) => p.id);
  for (const id of missed) {
    const unit = `U-${String(n++).padStart(2, "0")}`;
    unitOf.set(id, unit);
    clusters.push({ unit, label: "(未分组)", members: [id] });
  }

  if (opts.verbose) {
    for (const c of clusters) {
      process.stdout.write(`  ${c.unit} ${c.label}  ←  ${c.members.join(",")}\n`);
    }
    if (missed.length) process.stdout.write(`  模型漏掉 ${missed.length} 条，已单列：${missed.join(",")}\n`);
    if (duplicated.length) process.stdout.write(`  模型重复分组 ${duplicated.length} 条：${duplicated.join(",")}\n`);
  }

  return { unitOf, clusters, costUsd, latencyMs, missed, duplicated };
}

function parseGroups(text: string): Array<{ label: string; members: string[] }> {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`promotion 输出不是 json：${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }
  const rec = obj as { groups?: unknown };
  const list = Array.isArray(rec.groups) ? rec.groups : [];
  return list.map((item) => {
    const o = item as { label?: unknown; members?: unknown };
    return {
      label: String(o.label ?? "").trim(),
      members: Array.isArray(o.members) ? o.members.map((x) => String(x).trim()).filter(Boolean) : [],
    };
  });
}

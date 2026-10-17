import { fetchWithTimeout } from "../util/http.js";
import { renderScene, type Scene } from "./script.js";

/**
 * 人物别称表 —— 实体层的共指消解。
 *
 * ## 为什么需要它（实测驱动）
 *
 * 一份剧本里同一个人有三种称呼：**沈父 / 林昭的父亲 / 老爷**。
 * 归并层的判据是「施事、客体、时间三者对得上才算同一件事」，
 * 而「沈父」和「林昭的父亲」在字面上是两个不同的施事 —— 于是三次都判了 NEW。
 *
 * 后果是一条链：
 *
 *   人物别称未归一 → 归并判 NEW → 同一事实拆成 3 条命题
 *   → 知识挂在 A、使用点在 B → 时序泄漏（L-02）永远不可见
 *
 * 这就是 `design.md` 那句「**共指消解 ≠ 语义相似**」的真身 ——
 * 只不过它发生在**实体层**，不在命题层。
 *
 * ## 为什么不逐场抽
 *
 * 别称是**全剧性质**的（「老爷」这个称呼跟场景无关）。整本一次抽更准、更便宜。
 * 代价是剧本变了要重抽，所以它跟账本一起冻结。
 */

export interface CharacterEntry {
  /** 统一名称（用于归一化替换） */
  name: string;
  /** 剧本原文里出现过的其他称呼，逐字照抄 */
  aliases: string[];
}

export interface CharactersResult {
  characters: CharacterEntry[];
  costUsd: number;
  latencyMs: number;
  /** 被「原文可查」校验拦掉的别称 */
  rejected: number;
}

export const CHARACTER_INSTRUCTIONS = `下面是一部短剧的剧本。请列出登场人物，以及剧本对他们的**所有称呼**。

- \`name\`：该人物最有辨识度的称呼（会成为统一名）。
- \`aliases\`：剧本原文里出现过的**其他**称呼，逐字照抄。
  - 「林昭的父亲」「沈父」「老爷」是同一个人 → 同一个 name 下把其他两个写进 aliases。
  - **不要收代词**：「他」「她」「您」「那人」不算称呼。
  - 不要收只出现一次、且不指代具体人物群的临时描述。
- 只列有台词、或被反复提到的角色；过场龙套（如「董事」）可以不列。

输出 json，不要任何解释或代码块：
{"characters":[{"name":"沈父","aliases":["林昭的父亲","老爷"]}]}`;

export async function extractCharacters(scenes: Scene[], opts: { verbose?: boolean } = {}): Promise<CharactersResult> {
  const baseUrl = (process.env.EXTRACT_BASE_URL ?? process.env.JUDGE_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = process.env.EXTRACT_API_KEY ?? process.env.JUDGE_API_KEY ?? "";
  const model = process.env.EXTRACT_MODEL ?? process.env.JUDGE_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) throw new Error("缺少抽取服务配置");
  const thinking = process.env.EXTRACT_THINKING?.trim();
  const priceIn = Number(process.env.JUDGE_PRICE_IN ?? 0);
  const priceOut = Number(process.env.JUDGE_PRICE_OUT ?? 0);

  const scriptText = scenes.map((s) => `## ${s.id}\n${renderScene(s)}`).join("\n\n");
  const started = Date.now();

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `${CHARACTER_INSTRUCTIONS}\n\n---\n\n${scriptText}` }],
      response_format: { type: "json_object" },
      temperature: 0,
      ...(thinking ? { thinking: { type: thinking } } : {}),
    }),
  }, "人物表抽取");
  if (!res.ok) throw new Error(`人物表抽取返回 ${res.status}：${(await res.text()).slice(0, 200)}`);

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const costUsd =
    ((payload.usage?.prompt_tokens ?? 0) / 1e6) * priceIn +
    ((payload.usage?.completion_tokens ?? 0) / 1e6) * priceOut;

  const text = payload.choices?.[0]?.message?.content ?? "";
  const raw = parseCharacters(text);

  // 原文可查：别称必须是剧本里真实出现过的字符串，否则归一化会误伤别的词
  const allText = scenes.map((s) => s.lines.join("\n")).join("\n");
  let rejected = 0;
  const characters: CharacterEntry[] = [];
  for (const c of raw) {
    if (!c.name.trim()) continue;
    const aliases = c.aliases.filter((a) => {
      const ok = a.trim() && allText.includes(a);
      if (!ok) rejected += 1;
      return ok;
    });
    characters.push({ name: c.name.trim(), aliases: [...new Set(aliases)] });
  }

  if (opts.verbose) {
    for (const c of characters) {
      if (c.aliases.length) process.stdout.write(`  ${c.name}  ←  ${c.aliases.join(" / ")}\n`);
    }
  }

  return { characters, costUsd, latencyMs: Date.now() - started, rejected };
}

function parseCharacters(text: string): CharacterEntry[] {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`人物表输出不是 json：${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }
  const rec = obj as { characters?: unknown };
  const list = Array.isArray(rec.characters) ? rec.characters : [];
  return list.map((it) => {
    const o = it as { name?: unknown; aliases?: unknown };
    return {
      name: String(o.name ?? ""),
      aliases: Array.isArray(o.aliases) ? o.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
    };
  });
}

/**
 * 造一个归一化函数：把所有别称替换成统一名。
 *
 * **长串优先**：否则「林昭的父亲」会先被「林昭」之类的短串吃掉，替换结果变成乱码。
 * 这个归一化是**确定性**的，只做字符串替换，不调模型。
 */
export function buildNormalizer(characters: CharacterEntry[]): (s: string) => string {
  const pairs: Array<[string, string]> = [];
  for (const c of characters) {
    for (const a of c.aliases) {
      if (a !== c.name) pairs.push([a, c.name]);
    }
  }
  pairs.sort((x, y) => y[0].length - x[0].length);

  return (s: string): string => {
    let out = s;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
  };
}

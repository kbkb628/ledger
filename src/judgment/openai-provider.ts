import { fetchWithTimeout } from "../util/http.js";
import { buildPrompt } from "./prompt.js";
import type { JudgmentRequest, JudgmentProvider, JudgmentResult } from "./types.js";

/**
 * 通用 OpenAI 兼容 provider —— 可直接吃 DeepSeek / 春风API / OpenRouter。
 *
 * 用环境变量配置，因此换供应商只改配置、不改代码：
 *   JUDGE_BASE_URL     例如 https://api.deepseek.com
 *   JUDGE_API_KEY
 *   JUDGE_MODEL        例如 deepseek-v4-pro
 *   JUDGE_SAMPLES      采样次数，默认 1。>1 时启用「多次采样一致性」
 *   JUDGE_TEMPERATURE  默认：samples>1 时为 0.7，否则 0
 *   JUDGE_PRICE_IN     可选，美元 / 百万 input token
 *   JUDGE_PRICE_OUT    可选，美元 / 百万 output token
 *
 * ## 为什么要多次采样
 *
 * OpenAI 兼容接口**不返回各选项的概率分布**，所以 `margin` 无从计算，
 * 「三道门」里的间隔门会失效（实测 margin 恒为 1.00）。
 *
 * 多次采样是普通 LLM 上可得的替代信号：同一请求在 temperature>0 下跑 N 次，
 * **答案的一致率**就是可信度。它有两个好处：
 *   1. 把 probabilities 补成完整分布 → margin 可用
 *   2. 天然抗「自信地答错」——模型越不确定，采样越分散
 *
 * 代价是 N 倍调用（DeepSeek 便宜，可接受）。接入 JEV 后可直接关掉
 * （JEV 原生返回概率，不需要采样）。
 */
export class OpenAiCompatProvider implements JudgmentProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly priceIn: number;
  private readonly priceOut: number;
  private readonly samples: number;
  private readonly temperature: number;
  private readonly thinking?: string;
  private readonly reasoningEffort?: string;

  constructor(opts?: { name?: string; baseUrl?: string; apiKey?: string; model?: string }) {
    const baseUrl = opts?.baseUrl ?? process.env.JUDGE_BASE_URL;
    const apiKey = opts?.apiKey ?? process.env.JUDGE_API_KEY;
    const model = opts?.model ?? process.env.JUDGE_MODEL;

    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        "缺少判定服务配置。请设置环境变量 JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL（可参考 .env.example）",
      );
    }

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.samples = Math.max(1, Number(process.env.JUDGE_SAMPLES ?? 1) || 1);
    const tempEnv = process.env.JUDGE_TEMPERATURE;
    this.temperature = tempEnv !== undefined ? Number(tempEnv) : this.samples > 1 ? 0.7 : 0;
    this.priceIn = Number(process.env.JUDGE_PRICE_IN ?? 0);
    this.priceOut = Number(process.env.JUDGE_PRICE_OUT ?? 0);
    this.thinking = process.env.JUDGE_THINKING?.trim() || undefined;
    this.reasoningEffort = process.env.JUDGE_REASONING_EFFORT?.trim() || undefined;

    // DeepSeek 的思考模式不支持 temperature（设置了也不生效）。
    // 这意味着思考模式下无法引入随机性，self-consistency 会退化成 N 次相同结果。
    if (this.samples > 1 && this.thinking === "enabled") {
      console.warn(
        "⚠️  思考模式下 temperature 不生效，多次采样将得到相同结果 —— self-consistency 无效。\n" +
          "    如需 self-consistency，请设 JUDGE_THINKING=disabled。\n",
      );
    }

    const base = opts?.name ?? `openai-compat:${model}`;
    this.name = this.samples > 1 ? `${base}×${this.samples}` : base;
  }

  async judge(req: JudgmentRequest): Promise<JudgmentResult> {
    const started = Date.now();

    const settled = await Promise.allSettled(
      Array.from({ length: this.samples }, () => this.judgeOnce(req)),
    );

    const ok = settled
      .filter((r): r is PromiseFulfilledResult<SingleRun> => r.status === "fulfilled")
      .map((r) => r.value);

    if (ok.length === 0) {
      const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw first?.reason instanceof Error ? first.reason : new Error("全部采样失败");
    }

    const latencyMs = Date.now() - started;
    const costUsd = ok.reduce((a, r) => a + r.costUsd, 0);

    // 单次采样：直接返回，probabilities 只有一项（margin 不可用，如实反映）
    if (ok.length === 1) {
      const only = ok[0]!;
      return {
        choice: only.choice,
        probabilities: { [only.choice]: only.confidence },
        confidence: only.confidence,
        provider: this.name,
        latencyMs,
        costUsd,
        raw: only.raw,
      };
    }

    // 多次采样：以**一致率**作为可信度，probabilities 是完整频率分布
    const counts = new Map<string, number>();
    for (const r of ok) counts.set(r.choice, (counts.get(r.choice) ?? 0) + 1);

    let choice = "";
    let bestCount = -1;
    let bestAvgConf = -1;
    for (const [c, n] of counts) {
      const avgConf =
        ok.filter((r) => r.choice === c).reduce((a, r) => a + r.confidence, 0) / n;
      // 票数优先；并列时取平均自报置信度更高者
      if (n > bestCount || (n === bestCount && avgConf > bestAvgConf)) {
        choice = c;
        bestCount = n;
        bestAvgConf = avgConf;
      }
    }

    const probabilities: Record<string, number> = {};
    for (const [c, n] of counts) probabilities[c] = n / ok.length;

    return {
      choice,
      probabilities,
      confidence: bestCount / ok.length, // ← 一致率，不是模型自报值
      provider: this.name,
      latencyMs,
      costUsd,
      raw: ok.map((r) => r.raw).join("\n---\n"),
    };
  }

  private async judgeOnce(req: JudgmentRequest): Promise<SingleRun> {
    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: buildPrompt(req) }],
        response_format: { type: "json_object" },
        temperature: this.temperature,
        // DeepSeek 用请求体顶层字段控制思考模式（Python SDK 里的 extra_body 即此）
        ...(this.thinking ? { thinking: { type: this.thinking } } : {}),
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      }),
    }, "判定");

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`判定服务返回 ${res.status}：${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseJudgment(text, req.allowedChoices);

    const inTok = payload.usage?.prompt_tokens ?? 0;
    const outTok = payload.usage?.completion_tokens ?? 0;

    return {
      choice: parsed.choice,
      confidence: parsed.confidence,
      costUsd: (inTok / 1e6) * this.priceIn + (outTok / 1e6) * this.priceOut,
      raw: text,
    };
  }
}

interface SingleRun {
  choice: string;
  confidence: number;
  costUsd: number;
  raw: string;
}

/** 宽容解析：模型偶尔会带 markdown 包裹或多余字段 */
export function parseJudgment(
  text: string,
  allowed: string[],
): { choice: string; confidence: number } {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`判定输出不是 JSON：${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }

  const rec = obj as { choice?: unknown; confidence?: unknown };
  const choice = String(rec.choice ?? "");

  if (!allowed.includes(choice)) {
    throw new Error(`判定输出越界：choice="${choice}" 不在允许集合 [${allowed.join(", ")}] 内`);
  }

  const raw = Number(rec.confidence);
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;

  return { choice, confidence };
}

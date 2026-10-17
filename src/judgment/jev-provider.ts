import { fetchWithTimeout } from "../util/http.js";
import { BIND_MENTION_INSTRUCTIONS } from "./prompt.js";
import type { JudgmentRequest, JudgmentProvider, JudgmentResult } from "./types.js";

/**
 * JEV（TypeSafe System One）provider。
 *
 * 两个可用端点，请求体格式相同：
 *   TypeSafe 直连（默认）POST https://api.typesafe.ai/v1/systemone
 *   OpenRouter 中转      POST https://openrouter.ai/api/alpha/decisions
 *
 * 与 OpenAI 兼容 provider 的本质差别：
 *   - 请求体是 `state` + `questions` 结构，不是 chat messages
 *   - 问题用 **choice** 原语表达，每个选项带一条 `criteria`（判据）
 *   - **原生返回 probabilities** → `margin` 直接可用，不需要 self-consistency
 *
 * ⚠️ 实测已知限制（见 docs/test-log.md）：
 *   - `confidence` 与 `probabilities[choice]` **不同源**（0.21 vs 0.34），不可相减
 *   - 有**非确定性**：同输入两次判定可能不同
 *   - 准确率上限受限于「需要推理」的任务类型（JudgeBench 78.6）
 *
 * 环境变量：
 *   JEV_API_KEY      必填
 *   JEV_MODEL        默认 jev-latest
 *   JEV_BASE_URL     默认 https://api.typesafe.ai/v1/systemone
 *   JEV_CRITERIA_MODE 候选呈现方式，见 CriteriaMode（RSI 的可调维度之一）
 *   JEV_PRICE_IN     可选，美元 / 百万 input token
 */
const DEFAULT_BASE = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

/**
 * 候选如何呈现给 JEV —— RSI 迭代的主要维度。
 *
 * 依据 test-log.md 的实验：
 *   - `canonical`（v0）：散文 + 结构化字段
 *   - `relation`：三元组 + 散文。实测**未提升准确率**，且因压缩丢失字面线索
 *     反而弄坏了 G-014（「酒」字消失）
 *   - `keywords`（v1 假设）：散文 + 字段 + **区分性关键词**，用于补回被压缩掉的
 *     字面线索，同时保留语义描述
 */
export type CriteriaMode =
  | "canonical"
  | "relation"
  | "keywords"
  | "relation+keywords"
  | "keywords+distinguisher";

interface JevChoiceAnswer {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export class JevProvider implements JudgmentProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly priceIn: number;
  private readonly criteriaMode: CriteriaMode;

  constructor(opts?: { apiKey?: string; model?: string; criteriaMode?: CriteriaMode }) {
    const apiKey = opts?.apiKey ?? process.env.JEV_API_KEY;
    if (!apiKey) {
      throw new Error("缺少 JEV 配置。请在 .env 中设置 JEV_API_KEY");
    }
    this.apiKey = apiKey;
    this.model = opts?.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = process.env.JEV_BASE_URL ?? DEFAULT_BASE;
    this.priceIn = Number(process.env.JEV_PRICE_IN ?? 0);
    this.criteriaMode =
      opts?.criteriaMode ?? ((process.env.JEV_CRITERIA_MODE as CriteriaMode) || "canonical");
    const suffix = this.criteriaMode === "canonical" ? "" : `+${this.criteriaMode}`;
    this.name = `jev:${this.model}${suffix}`;
  }

  async judge(req: JudgmentRequest): Promise<JudgmentResult> {
    const started = Date.now();

    const body: Record<string, unknown> = {
      state: {
        mention: req.mention.surface,
        scene: req.mention.scene,
        mention_kind: req.mention.kind,
        context: req.mention.context,
      },
      questions: {
        bind: {
          type: "choice",
          instructions: req.instructions ?? BIND_MENTION_INSTRUCTIONS,
          criteria: buildCriteria(req, this.criteriaMode),
        },
      },
    };
    // model 是**必填**字段 —— TypeSafe 直连缺省会返回 422（Field required）
    body.model = this.model;

    const res = await fetchWithTimeout(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, "JEV 判定");

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`JEV 返回 ${res.status}：${text.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      model?: string;
      answers?: Record<string, JevChoiceAnswer>;
      usage?: { prompt_tokens?: number; input_tokens?: number };
    };

    const answer = payload.answers?.bind;
    if (!answer) {
      throw new Error(`JEV 响应缺少 answers.bind：${JSON.stringify(payload).slice(0, 300)}`);
    }

    const choice = String(answer.choice ?? "");
    if (!req.allowedChoices.includes(choice)) {
      throw new Error(
        `JEV 输出越界：choice="${choice}" 不在允许集合 [${req.allowedChoices.join(", ")}] 内`,
      );
    }

    const probabilities = answer.probabilities ?? {};
    const confidence =
      typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
        ? answer.confidence
        : (probabilities[choice] ?? 0);

    const inTok = payload.usage?.prompt_tokens ?? payload.usage?.input_tokens ?? 0;

    return {
      choice,
      probabilities,
      confidence,
      provider: payload.model ? `${this.name}(${payload.model})` : this.name,
      latencyMs,
      costUsd: (inTok / 1e6) * this.priceIn,
      raw: JSON.stringify(answer),
    };
  }
}

/** 把候选命题渲染成 JEV 的 `criteria`——每个选项一条判据。 */
export function buildCriteria(
  req: JudgmentRequest,
  mode: CriteriaMode = "canonical",
): Record<string, string> {
  const criteria: Record<string, string> = {};
  const useRelation = mode.startsWith("relation");
  const useKeywords = mode.includes("keywords");
  const useDistinguisher = mode.includes("distinguisher");

  for (const c of req.candidates) {
    // type 可能被消融实验置空（见 eval/run-eval.ts 的 EVAL_ABLATE）
    const meta: string[] = c.type ? [`type=${c.type}`] : [];
    if (c.agent) meta.push(`agent=${c.agent}`);
    if (c.patient) meta.push(`patient=${c.patient}`);
    if (c.object) meta.push(`object=${c.object}`);
    if (c.timeRef) meta.push(`time=${c.timeRef}`);

    // 首句：三元组优先，或散文 + 结构化字段
    const head =
      useRelation && c.relation
        ? `${c.relation}　[${c.canonical}]`
        : `${c.canonical}（${meta.join("，")}）`;

    // 第二句：关键词（补回被结构化压缩掉的字面线索）
    const kw = useKeywords && c.keywords?.length ? `　｜ 典型表述：${c.keywords.join("、")}` : "";

    // 第三句：区分维度（用于打破「同客体多命题」的混淆）
    const dist = useDistinguisher && c.distinguisher ? `　｜ 区分维度：${c.distinguisher}` : "";

    criteria[c.id] = `${head}${kw}${dist}`;
  }

  criteria["NEW"] = "上面任何一条都不是——这是一个新命题，应新建";
  criteria["UNSURE"] = "线索不足或互相冲突，无法判定，拒绝作答";

  return criteria;
}

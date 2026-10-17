/**
 * 上下文协议 —— 把「模型到底看到了什么」写成可核验的不变量。
 *
 * ## 为什么需要（借自 STAGE 基准）
 *
 * STAGE（arXiv 2601.08510）在每个任务文件里带一个 `context_protocol` 块：
 *
 * ```jsonc
 * "full_screenplay_prefix_used": false,
 * "previous_state_visible_to_memory_extractor": false,
 * "previous_state_model_projection": "claim_text_only",
 * "screenplay_scope": "previous_checkpoint_exclusive_to_current_checkpoint_inclusive"
 * ```
 *
 * 最后一行就是「不得未来泄漏」——**写进数据、可被程序核验的边界**，不是原则口号。
 *
 * 我的评测此前**没有任何这类声明**：别人拿我的结果，无法判断
 * 「抽取时看到了多少上下文」「上一场的结论有没有回流」「候选是怎么生成的」。
 * 而这些恰恰是决定数字含义的东西 —— 例如 P1-1 只把上下文从一句扩到两句，
 * 准确率就从 91.7% 跳到 100%；不声明上下文宽度，那个 100% 无法解读。
 *
 * ## 做法
 *
 * 这里的字段**不是手填的**，而是从运行配置与代码事实推导：
 * 它们是「当前这版流水线实际的行为」，改动会导致哈希变化，
 * 于是结果自动变得不可比（与 scorer 版本化同一套逻辑）。
 */

import { createHash } from "node:crypto";

export interface ContextProtocol {
  /** 抽取：是否整本一次喂入（本项目为 false，逐场） */
  extractionWholeScript: boolean;
  /** 抽取：提示词里是否附上「已抽出的命题清单」（会引入跨场回流，v1 起为 false） */
  extractionPriorPropositionsVisible: boolean;
  /** 归并：候选召回方式 */
  mergeCandidateRecall: "bigram-blocking";
  /** 判定：候选来自自动召回还是给定（`gold` 会虚高） */
  judgeCandidates: "recalled" | "gold";
  /** 判定：上下文的宽度（P1-1 证明它对准确率影响最大） */
  judgeContextWidth: "line" | "neighbors" | "scene";
  /** 认知层：是否允许「用自己台词证明自己知情」 */
  mindSelfEstablishmentAllowed: boolean;
  /** 认知层：在场者规则的授予场次口径 */
  mindGrantScope: "first_seen" | "established";
}

/** 从环境与开关推导当前生效的上下文协议（不手填） */
export function currentContextProtocol(): ContextProtocol {
  const ctx = (process.env.EVAL_CONTEXT ?? "line") as ContextProtocol["judgeContextWidth"];
  return {
    extractionWholeScript: false, // 代码事实：extractScenes 逐场调用
    extractionPriorPropositionsVisible: false, // 代码事实：v1 起 prompt 不再带已知命题清单
    mergeCandidateRecall: "bigram-blocking",
    judgeCandidates: process.env.EVAL_GOLD_CANDIDATES === "1" ? "gold" : "recalled",
    judgeContextWidth: ctx === "neighbors" || ctx === "scene" ? ctx : "line",
    mindSelfEstablishmentAllowed: process.env.R1_NO_SELF_ESTABLISH !== "1",
    mindGrantScope: process.env.R1_ESTABLISHED === "0" ? "first_seen" : "established",
  };
}

/** 上下文协议短标识：`ctx@ab12cd34ef56` */
export function contextStamp(): string {
  const p = currentContextProtocol();
  const h = createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 12);
  return `ctx@${h}`;
}

/**
 * 可比性判定：上下文协议不同 → 数字不可比。
 *
 * 例：P1-1 把上下文从 `line` 改成 `neighbors`，准确率 91.7% → 100%。
 * 跨这两个配置比较分数，等于把「多给了模型信息」误记成「模型变强了」。
 */
export function sameContext(a: ContextProtocol, b: ContextProtocol): { ok: boolean; why: string } {
  const diffs = (Object.keys(a) as Array<keyof ContextProtocol>).filter((k) => a[k] !== b[k]);
  return diffs.length === 0
    ? { ok: true, why: "上下文协议一致" }
    : { ok: false, why: `上下文协议不同：${diffs.map((k) => `${k}(${String(a[k])}→${String(b[k])})`).join(", ")}` };
}

import type { JudgmentProvider } from "../judgment/types.js";
import type { DraftProposition } from "../extraction/types.js";
import type { LeakIssue } from "./r1.js";

/**
 * `should_allow` 的**判定层版** —— 只在「许可被撤销后仍然报出」的候选上问一次。
 *
 * ## 为什么需要它
 *
 * 回合 31/32 实测：词表级 should_allow（自陈来源标记 + 前提性知识）能吸收 2 条误报，
 * 但挡不住最常见的合法情形 —— **说话人本来就该知道自己说的事**：
 * 周管说「老爷半年前就走了」、何静说「两千三百万」（她自己的钱）、陈立报账。
 * 账本看不见这些背景，只能靠语义判断。
 *
 * ## 为什么放在报出之后再问（而不是算完再问）
 *
 * 报出的量很小（dev 6~18 条、茶馆 4~5 条），一次问询的成本可忽略；
 * 而把它放在「撤销自证」的规则之后，问题才具体：
 * **这条泄漏是不是因为账本把一个合法来源漏掉了？**
 *
 * ## 判定要点
 *
 * - 当事人/施事：这件事本来就是他自己做的、他身上的 → 合法
 * - 目击者：他在场、并且这件事发生在同一场或更早 → 合法
 * - 被专门告知：台词/said 上下文里明确写着「某某告诉我 / 我一直知道」→ 合法
 * - 只是听说/猜的，或干脆没有任何来源 → 不合法（保留报出）
 *
 * 拿不准选 `UNSURE`，默认**保留报出**（宁可多报，不掩盖真实泄漏）。
 */
export const LEAK_ALLOW_INSTRUCTIONS = `你在帮一部剧本的连续性检查做一次复核。

检查系统报出一条「知识泄漏」：某个角色在某一幕说出了某事，但账本里没有记录他从哪里得知这件事。

现在请你判断：**这个角色有没有可能通过剧本已经给出的渠道合法知道这件事？**

只考虑这四种合法渠道：
1. **当事人／施事**：这件事本身就是他做的、发生在他身上的、属于他本人的财产或身份；
2. **目击**：他当时就在场；
3. **被专门告知**：台词或上下文里写明有人告诉过他；
4. **公开信息**：这件事在故事世界里是人所共知的常识（例如亲人的死讯、公开的婚约）。

若只符合「他大概听说过 / 他应该能猜到 / 剧情需要他知道」，**不算**合法渠道。
拿不准就选 UNSURE。`;

export interface LeakAllowOptions {
  provider: JudgmentProvider;
  /** UNSURE 时是否放行（默认 false：保留报出） */
  allowOnUnsure?: boolean;
  scenes?: Array<{ id: string; lines: string[] }>;
  verbose?: boolean;
}

export interface LeakAllowResult {
  issues: LeakIssue[];
  allowed: number;
  unsure: number;
  calls: number;
  costUsd: number;
  latencyMs: number;
}

export async function allowLeaks(
  issues: LeakIssue[],
  ledger: DraftProposition[],
  opts: LeakAllowOptions,
): Promise<LeakAllowResult> {
  const byId = new Map(ledger.map((p) => [p.id, p]));
  const allowOnUnsure = opts.allowOnUnsure ?? false;
  const out: LeakIssue[] = [];
  let allowed = 0;
  let unsure = 0;
  let calls = 0;
  let costUsd = 0;
  const started = Date.now();

  for (const iss of issues) {
    const p = byId.get(iss.propositionId);
    if (!p) {
      out.push(iss);
      continue;
    }
    const scene = opts.scenes?.find((s) => s.id === iss.useScene);
    // 上下文：本场原文（判断「目击/被告知」要靠它），上限防止超长
    const context = (scene?.lines ?? []).join("\n").slice(0, 1600);
    try {
      const r = await opts.provider.judge({
        task: "bind_mention",
        instructions: LEAK_ALLOW_INSTRUCTIONS,
        mention: {
          surface: iss.surface,
          scene: iss.useScene,
          context: `角色：${iss.character}\n台词：${iss.line}\n本场原文：\n${context}`,
          kind: "repeated_surface",
        },
        candidates: [
          { id: "LEGIT", canonical: "他有剧本给出的合法渠道知道这件事（当事人/目击/被专门告知/公开信息）", type: "" },
          { id: "LEAK", canonical: "剧本没有给出任何渠道，这是真正的知识泄漏", type: "" },
        ],
        allowedChoices: ["LEGIT", "LEAK", "UNSURE"],
      });
      calls += 1;
      costUsd += r.costUsd;
      if (r.choice === "LEGIT") {
        allowed += 1;
        if (opts.verbose) process.stdout.write(`  ↷ 放行 ${iss.useScene} ${iss.character}「${iss.surface}」→ 合法渠道\n`);
        continue;
      }
      if (r.choice === "UNSURE") {
        unsure += 1;
        if (opts.verbose) process.stdout.write(`  ? 存疑 ${iss.useScene} ${iss.character}「${iss.surface}」\n`);
        if (allowOnUnsure) {
          allowed += 1;
          continue;
        }
      }
      out.push(iss);
    } catch (err) {
      // 判定失败不静默放行 —— 宁可保留报出（否则会掩盖真实泄漏）
      const m = err instanceof Error ? err.message : String(err);
      if (opts.verbose) process.stdout.write(`  ! 豁免判定失败，保留报出：${m.slice(0, 80)}\n`);
      out.push(iss);
    }
  }

  return { issues: out, allowed, unsure, calls, costUsd, latencyMs: Date.now() - started };
}

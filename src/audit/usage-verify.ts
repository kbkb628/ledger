import type { DraftProposition } from "../extraction/types.js";
import type { JudgmentProvider } from "../judgment/types.js";
import type { Usage } from "./r1.js";

/**
 * usage 语义校验 —— 用判定层过滤「碰巧共享词」造成的假使用点。
 *
 * ## 为什么字符串匹配修不了（回合 24 的数据结论）
 *
 * `buildUsages` 靠子串包含判定「这句话提到了命题 P」。但真实剧本里大量巧合重叠：
 *
 *   命题：「康顺子担心**大力**回来的事被人知道会连累王家」
 *   台词：「我顶不放心的还是**大力**的事」（王利发说的，在担心另一件事）
 *   → 共享「大力」，被判为「王利发用了这条命题」，误报。
 *
 * 实测：长度阈值、出现频率、人名过滤都**无法区分**（12 字整句照样误报，5 字短引用反而正确）。
 * 唯一的判别依据是**语义**：这句话到底在不在指涉那件事。
 *
 * ## 为什么能便宜地做
 *
 * 项目已验证的判定层（JEV）在黄金集上 91.7%，单次 0.23s、约 $0.00005。
 * `real` 集 253 个使用点 → 约 60 秒、$0.01。可承受。
 */

export const USAGE_VERIFY_INSTRUCTIONS = `判断「这句话」是否在**引用**给定的命题。

引用 = 说话人在**指涉那件事**（可能是简称、代称、模糊指代）。
不算引用：只是**碰巧出现相同的词**（人名、常用词、口头禅），而实际在说别的事。

判定要点：
- 这句话谈的对象、动作，是否就是命题描述的那件事？
- 如果去掉那个共享的词，两句话还有关系吗？没有 → 不是引用。
- 拿不准就选 UNRELATED（宁可不报，也不要制造假使用点）。

提示：命题一般是"某事实"，对话里提到该事实的相关人/物通常算引用；
但如果说话人谈的是**同一人物的另一件事**，就不算。`;

export interface UsageVerifyOptions {
  provider: JudgmentProvider;
  /** UNSURE 时是否保留该使用点。默认保留（保守：宁可多报，不漏掉泄漏） */
  keepOnUnsure?: boolean;
  verbose?: boolean;
}

export interface UsageVerifyResult {
  usages: Usage[];
  kept: number;
  dropped: number;
  unsure: number;
  calls: number;
  costUsd: number;
  latencyMs: number;
}

export async function verifyUsages(
  usages: Usage[],
  ledger: DraftProposition[],
  opts: UsageVerifyOptions,
): Promise<UsageVerifyResult> {
  const byId = new Map(ledger.map((p) => [p.id, p]));
  const keepOnUnsure = opts.keepOnUnsure ?? true;
  const out: Usage[] = [];
  let dropped = 0;
  let unsure = 0;
  let calls = 0;
  let costUsd = 0;
  const started = Date.now();

  for (const u of usages) {
    const p = byId.get(u.propositionId);
    if (!p) {
      out.push(u);
      continue;
    }
    try {
      const r = await opts.provider.judge({
        task: "bind_mention",
        instructions: USAGE_VERIFY_INSTRUCTIONS,
        mention: {
          surface: u.surface,
          scene: u.scene,
          // 上下文用该说话人这一整句——判断「在不在说那件事」需要完整语义
          context: u.line,
          kind: "repeated_surface",
        },
        candidates: [
          { id: p.id, canonical: p.canonical, keywords: p.aliases.map((a) => a.surface), type: "" },
          { id: "UNRELATED", canonical: "这句话在说别的事，只是碰巧共享了词", type: "" },
        ],
        allowedChoices: [p.id, "UNRELATED", "UNSURE"],
      });
      calls += 1;
      costUsd += r.costUsd;

      if (r.choice === "UNRELATED") {
        dropped += 1;
        if (opts.verbose) process.stdout.write(`  ✗ ${u.scene} ${u.character}「${u.surface}」→ 非引用\n`);
        continue;
      }
      if (r.choice === "UNSURE") {
        unsure += 1;
        if (!keepOnUnsure) {
          dropped += 1;
          continue;
        }
      }
      out.push(u);
    } catch (err) {
      // 校验失败不静默丢使用点 —— 宁可保留（否则会掩盖真实泄漏）
      const m = err instanceof Error ? err.message : String(err);
      if (opts.verbose) process.stdout.write(`  ! 校验失败，保留该使用点：${m.slice(0, 80)}\n`);
      out.push(u);
    }
  }

  return { usages: out, kept: out.length, dropped, unsure, calls, costUsd, latencyMs: Date.now() - started };
}

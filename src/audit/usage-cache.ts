import { createHash } from "node:crypto";

import type { Usage } from "./r1.js";
import type { JudgmentProvider } from "../judgment/types.js";
import { verifyUsages } from "./usage-verify.js";

/**
 * usage 的持久化 —— **wiki 的第三条回写通道**。
 *
 * ## 为什么（一条自我诊断）
 *
 * 查账本结构时发现：`ledger.json` 里**没有 usages 字段**。
 * 于是每次审计都要重算使用点，并在默认开启的 `R1_USAGE_VERIFY` 下再做一遍
 * 253 次判定（63s / $0.008）—— 而上一次的结论**被直接丢掉**。
 *
 * 结论是：**wiki 只从「读剧本」学习，不从「自己判过什么」学习。**
 * 它积累了剧本，却不积累判断。
 *
 * ## 三条累积通道
 *
 * | 通道 | 状态 |
 * |---|---|
 * | 抽取（新增材料） | ✅ 一直在做 |
 * | 归并（同一性 + 别名增长） | ✅ 一直在做 |
 * | **审计结论回写** | ❌ 本模块补的就是这条 |
 *
 * ## 为什么必须带版本戳才安全
 *
 * usage 是**打分器的产物**：`buildUsages` 的规则、`usage-verify` 的判定、
 * 上下文协议都会改变「哪些使用点算数」。
 * 所以缓存必须同时记录 `scorer` 与 `contextProtocol`；
 * **任一不匹配就作废重算**，否则会拿旧打分器的结论冒充新打分器的结果
 * （这正是回合 20 之后建立的「可比性」纪律在数据层的延伸）。
 */

export interface StoredUsage extends Usage {
  /**
   *  provenance：
   *  - `extracted`：字符串匹配得到，未经语义校验
   *  - `verified`：经判定层确认「确实在引用该命题」
   *  - `human`：人工确认（预留）
   */
  provenance: "extracted" | "verified" | "human";
}

export interface UsageCacheStamps {
  scorer: string;
  contextProtocol: string;
  /**
   * 账本内容指纹。**没有它，缓存是跨剧本串味的**：
   * 打分器戳只覆盖「规则版本」，换一份账本（另一部剧本、或同一部剧本重抽）
   * 戳仍然相同，于是一份账本的使用点会被当成另一份账本的结论复用
   * （实测踩到：审计 A 剧本时复用了 B 剧本缓存，直接报 0 个使用点）。
   */
  ledger?: string;
}

/** 账本内容指纹：命题 id / 规范说法 / 全部说法 的稳定哈希 */
export function ledgerKey(ledger: { id: string; canonical: string; aliases: Array<{ surface: string }> }[]): string {
  const corpus = ledger
    .map((p) => `${p.id}\u0001${p.canonical}\u0001${p.aliases.map((a) => a.surface).join("\u0002")}`)
    .join("\u0003");
  return `lg@${createHash("sha256").update(corpus).digest("hex").slice(0, 12)}`;
}

export interface ResolveOptions {
  provider?: JudgmentProvider;
  /** 是否跑语义校验（对应 R1_USAGE_VERIFY） */
  verify: boolean;
  /** 当前打分器与上下文协议戳 */
  stamps: UsageCacheStamps;
  /** 逐行打印 */
  verbose?: boolean;
}

export interface ResolveResult {
  usages: StoredUsage[];
  /** 是否命中缓存 */
  fromCache: boolean;
  /** 缓存作废原因（未命中时） */
  invalidatedBy?: string;
  /** 应当持久化的完整戳（含账本内容指纹）：调用方回写时必须用它，而不是自己那份 */
  stamps: UsageCacheStamps;
  verifyStats?: { kept: number; dropped: number; unsure: number; calls: number; costUsd: number; latencyMs: number };
}

/**
 * 取得使用点：**命中缓存则直接复用，否则重算并按需校验**。
 *
 * @param cached 账本里已存的 usages 与戳
 * @param compute 未命中时的重算函数（由调用方提供，避免本模块依赖抽取/归并）
 */
export async function resolveUsages(
  ledger: { id: string; canonical: string; aliases: Array<{ surface: string }> }[],
  cached: { usages?: StoredUsage[]; stamps?: UsageCacheStamps } | undefined,
  compute: () => Usage[],
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const stamps: UsageCacheStamps = { ...opts.stamps, ledger: ledgerKey(ledger) };

  // ── 缓存有效性：三项戳必须完全一致 ──
  if (cached?.usages && cached.stamps) {
    if (cached.stamps.scorer !== stamps.scorer) {
      return notCached(compute, ledger, opts, stamps, `打分器已变（${cached.stamps.scorer} → ${stamps.scorer}）`);
    }
    if (cached.stamps.contextProtocol !== stamps.contextProtocol) {
      return notCached(compute, ledger, opts, stamps, `上下文协议已变（${cached.stamps.contextProtocol} → ${stamps.contextProtocol}）`);
    }
    if (cached.stamps.ledger !== stamps.ledger) {
      return notCached(compute, ledger, opts, stamps, `账本内容已变（${cached.stamps.ledger ?? "无指纹"} → ${stamps.ledger}）`);
    }
    if (opts.verbose) process.stdout.write(`  ♻️ 复用账本里已存的 ${cached.usages.length} 个使用点（打分器 / 上下文 / 账本 均未变）\n`);
    return { usages: cached.usages, fromCache: true, stamps };
  }

  return notCached(compute, ledger, opts, stamps, cached?.usages ? "缓存缺少版本戳（旧账本）" : "账本里没有持久化的使用点");
}

async function notCached(
  compute: () => Usage[],
  ledger: { id: string; canonical: string; aliases: Array<{ surface: string }> }[],
  opts: ResolveOptions,
  stamps: UsageCacheStamps,
  why: string,
): Promise<ResolveResult> {
  const raw = compute();
  if (!opts.verify) {
    return {
      usages: raw.map((u) => ({ ...u, provenance: "extracted" as const })),
      fromCache: false,
      invalidatedBy: why,
      stamps,
    };
  }
  if (!opts.provider) {
    return {
      usages: raw.map((u) => ({ ...u, provenance: "extracted" as const })),
      fromCache: false,
      invalidatedBy: `${why}；且未提供判定器，跳过语义校验`,
      stamps,
    };
  }

  const vr = await verifyUsages(raw, ledger as never, { provider: opts.provider });
  const keptIds = new Set(vr.usages.map((u) => `${u.character}|${u.scene}|${u.surface}|${u.propositionId}`));
  const usages: StoredUsage[] = raw
    .filter((u) => keptIds.has(`${u.character}|${u.scene}|${u.surface}|${u.propositionId}`))
    .map((u) => ({ ...u, provenance: "verified" as const }));

  return {
    usages,
    fromCache: false,
    invalidatedBy: why,
    stamps,
    verifyStats: {
      kept: vr.kept,
      dropped: vr.dropped,
      unsure: vr.unsure,
      calls: vr.calls,
      costUsd: vr.costUsd,
      latencyMs: vr.latencyMs,
    },
  };
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DraftProposition } from "../extraction/types.js";
import type { Scene } from "../extraction/script.js";
import type { KnowledgeFact } from "../audit/r1.js";

/**
 * 账本的落盘形态 —— 「wiki」的存储层。
 *
 * ## 三条不变量（都由前面的实验逼出来，不是设计偏好）
 *
 * 1. **判决落盘即冻结，绝不重算。**
 *    JEV 有非确定性（rsi-log），P0-1 又测出候选顺序携带信息。每次启动重跑归并，
 *    同一份剧本第二次可能得到不同账本 —— 不可复现，审计工具就废了。
 *    所以账本只在 `ingest` / 增量 `record` 时写入，之后只读。
 *
 * 2. **判决流水 append-only。**
 *    每一笔归并/审计/豁免都进 `decisions.jsonl`，带 `who / when / impl`。
 *    这是「这个结论是哪一版账本、哪一版指令产出的」的唯一证据链。
 *
 * 3. **别名带来源**（`source: extracted | human`）。
 *    评测只认 `extracted`。这是 rsi-log「手写关键词」那条效度教训的机械化防线。
 */

/** 落盘的一条命题 —— 在抽取层的 DraftProposition 上补审计单元与别名来源 */
export interface StoredProposition extends DraftProposition {
  /** 所属审计单元（promotion 产出；未跑时为 null） */
  auditUnit: string | null;
  /** 别名来源；缺省视为 extracted（旧账本兼容） */
  aliasSource: Record<string, "extracted" | "human">;
}

export interface Waiver {
  /** 豁免键：`角色|命题id`。check 与 audit 都按它跳过 */
  key: string;
  character: string;
  propositionId: string;
  reason: string;
  at: string;
}

export interface LedgerFile {
  version: 1;
  series: string;
  /** 账本路径回显给 agent —— 否则用户不知道东西落在哪 */
  path: string;
  /** 剧本原文，check 需要场景上下文 */
  script: string;
  /** 剧本的场景顺序（叙事顺序，不是集数顺序） */
  sceneOrder: string[];
  /** 逐个场景的正文与元数据 —— check / usages 需要 */
  scenes: Scene[];
  propositions: StoredProposition[];
  knowledge: KnowledgeFact[];
  waivers: Waiver[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LEDGER_HOME = ".ledger";

/**
 * 决定账本落在哪 —— 显式化，不依赖 cwd 的偶然性。
 *
 *   1. `LEDGER_HOME`（绝对路径）→ 用它
 *   2. 否则 `<cwd>/.ledger`
 *
 * 为什么不放 agent 的私有目录：`ledger.json` 是**项目资产**（可 review、可 diff、
 * 随 git 走），`decisions.jsonl` 是证据链。产物不该藏在工具的缓存目录里。
 */
export function ledgerHome(): string {
  const env = process.env.LEDGER_HOME?.trim();
  return env ? resolve(env) : join(process.cwd(), DEFAULT_LEDGER_HOME);
}

export function ledgerPath(home = ledgerHome(), series = "default"): string {
  return join(home, series, "ledger.json");
}

export function decisionsPath(home = ledgerHome(), series = "default"): string {
  return join(home, series, "decisions.jsonl");
}

export function loadLedger(home = ledgerHome(), series = "default"): LedgerFile | null {
  const p = ledgerPath(home, series);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as LedgerFile;
  // 旧账本缺字段时补齐，避免读挂
  raw.waivers ??= [];
  for (const prop of raw.propositions) {
    prop.auditUnit ??= null;
    if (!prop.aliasSource) {
      prop.aliasSource = Object.fromEntries(prop.aliases.map((a) => [a.surface, "extracted" as const]));
    }
  }
  raw.path = p;
  return raw;
}

export function saveLedger(ledger: LedgerFile, home = ledgerHome()): void {
  const p = ledgerPath(home, ledger.series);
  mkdirSync(dirname(p), { recursive: true });
  ledger.path = p;
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(ledger, null, 2), "utf8");
}

/** append-only 判决流水 */
export interface DecisionRecord {
  at: string;
  kind: "ingest" | "record" | "merge" | "audit" | "waive" | "check";
  [field: string]: unknown;
}

export function appendDecision(rec: DecisionRecord, home = ledgerHome(), series = "default"): void {
  const p = decisionsPath(home, series);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify({ ...rec, at: rec.at ?? new Date().toISOString() })}\n`, "utf8");
}

/** 汇总账本规模，用于工具返回值与报错提示 */
export function summarize(ledger: LedgerFile): Record<string, unknown> {
  return {
    series: ledger.series,
    ledgerPath: ledger.path,
    propositions: ledger.propositions.length,
    aliases: ledger.propositions.reduce((a, p) => a + p.aliases.length, 0),
    knowledge: ledger.knowledge.length,
    waivers: ledger.waivers.length,
    scenes: ledger.sceneOrder.length,
  };
}

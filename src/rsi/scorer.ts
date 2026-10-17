/**
 * 打分器版本 —— 「结果可比性」的另一半。
 *
 * ## 为什么需要（我的真实疏漏）
 *
 * 测试集版本（`testset@ver#hash`）我只做了一半。但**打分逻辑本身也在改**：
 * 这个项目里 `src/audit/r1.ts` 被改过至少六次 —— `speakerOf` 修叙述检测、
 * 过滤纯人名说法、短引用识别键、在场者规则、显式优先、审计单元提升……
 *
 * 每一次都会改变「同一份账本会报出什么」。而我从没给打分器编过版本，
 * 于是出现这种局面：**新旧两个分数不可比，但记录里看不出来是打分器换了。**
 *
 * ## 借用的做法
 *
 * Inspect / inspect_evals 用 `N-X` 双段版本，其中 N 的升级条件官方列明包括
 * **打分逻辑、数据集、提示模板、影响结果的参数、影响结果的 bugfix** ——
 * 也就是说打分器与数据集**共用一个可比性版本**：任一变动，分数就不可比。
 *
 * 这里用更轻的做法达到同样目的：给打分器算一个内容哈希，
 * 结果里写 `scorer: "r1@ab12cd34ef56"`。
 *
 * ## 可比性规则（代码强制）
 *
 *   A 与 B 的分数可比 ⟺ dataset 的 `id@ver#hash` 相同 **且** scorer 的 `id@hash` 相同
 *
 * 任一项不同 → 禁止在同一条比较表里比，只能各自作为新基线。
 * 这是「测试集内容变了就拒绝跑」的对偶：**打分器变了就拒绝比。**
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/**
 * 每类打分器由哪些源文件决定。
 * 加文件 = 换了打分器（会自然升 hash）。
 */
const SCORER_FILES: Record<ScorerKind, string[]> = {
  /** R1 审计：述语/在场/显式优先/单元提升/人名过滤 */
  r1: [
    "src/audit/r1.ts",
    "src/audit/check.ts",
    "src/extraction/merge.ts", // 归并决策会改变账本，从而改变可报出的东西
  ],
  /** 判定层：指令 + provider + 候选呈现 */
  judge: [
    "src/judgment/prompt.ts",
    "src/judgment/jev-provider.ts",
    "src/judgment/openai-provider.ts",
    "src/judgment/types.ts",
  ],
  /** 端到端：召回与排序口径写在这个脚本里 */
  e2e: ["eval/run-e2e.ts", "eval/match.ts"],
};

/** R1 的开关会改变打分结果，必须计入 */
const R1_FLAGS = [
  "R1_AGENT",
  "R1_PRESENCE",
  "R1_UNITS",
  "R1_CHAR_HINT",
  "R1_SHORTKEY",
  "R1_KEY_LEN",
  "R1_KEY_FREQ",
  "R1_NAME_SKIP",
  "R1_ESTABLISHED",
] as const;

export type ScorerKind = "r1" | "judge" | "e2e";

function hashSources(files: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    const p = resolve(root, rel);
    h.update(rel);
    h.update(existsSync(p) ? readFileSync(p) : Buffer.from("(missing)"));
  }
  return h.digest("hex").slice(0, 12);
}

/** 打分器短标识：`r1@ab12cd34ef56` */
export function scorerStamp(kind: ScorerKind): string {
  const h = createHash("sha256");
  h.update(kind);
  h.update(hashSources(SCORER_FILES[kind]));
  if (kind === "r1") {
    for (const f of R1_FLAGS) h.update(`${f}=${process.env[f] ?? "default"};`);
  }
  return `${kind}@${h.digest("hex").slice(0, 12)}`;
}

export interface Comparability {
  dataset: string | null;
  scorer: string;
}

/** 两组结果是否可比 —— 数据集与打分器**都必须相同** */
export function comparable(a: Comparability, b: Comparability): { ok: boolean; why: string } {
  if (a.dataset !== b.dataset) {
    return { ok: false, why: `数据集不同（${a.dataset ?? "?"} vs ${b.dataset ?? "?"}）` };
  }
  if (a.scorer !== b.scorer) {
    return { ok: false, why: `打分器不同（${a.scorer} vs ${b.scorer}）` };
  }
  return { ok: true, why: "同数据集同打分器" };
}

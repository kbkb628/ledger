import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { EXTRACTION_INSTRUCTIONS } from "../extraction/prompt.js";
import { CHARACTER_INSTRUCTIONS } from "../extraction/characters.js";
import { PROMOTE_INSTRUCTIONS } from "../extraction/promote.js";
import { BIND_MENTION_INSTRUCTIONS, MERGE_PROPOSITIONS_INSTRUCTIONS } from "../judgment/prompt.js";

/**
 * 版本指纹 —— 「这个数字是哪个版本跑出来的」的唯一答案。
 *
 * ## 为什么必须有它
 *
 * 冻结基线解决了同一份输入的可比性，但没解决**产出解释**：
 * 下次抽取得到不同账本时，无法判断差异来自模型漂移、prompt 改动、还是开关组合。
 * 三种原因对应的处置完全不同（前者要固定模型版本，后两者是我自己的改动）。
 *
 * ## 指纹组成
 *
 * - `commit`：代码版本（git short hash，工作区脏时加 `-dirty`）
 * - `promptHash`：所有指令文本的哈希 —— 改一个字就会变
 * - 模型名：抽取与判定各自用的模型
 * - `flags`：RSI 开关组合（只记已设的，按名排序保证稳定）
 */

export interface VersionFingerprint {
  hash: string;
  commit: string;
  extractModel: string;
  judgeModel: string;
  promptHash: string;
  flags: Record<string, string>;
}

const RSI_FLAG_NAMES = [
  "R1_AGENT",
  "R1_PRESENCE",
  "R1_UNITS",
  "R1_CHAR_HINT",
  "R1_SHORTKEY",
  "R1_KEY_LEN",
  "R1_KEY_FREQ",
  // ↓ 与 scorer.ts 的 R1_FLAGS 对齐：这几个开关会改变「哪些使用点算数」，
  //   但实验指纹里原先没有它们，导致 R1_USAGE_VERIFY=0 的实验记录与基线**无法区分**。
  "R1_NAME_SKIP",
  "R1_USAGE_VERIFY",
  "R1_MIN_SURFACE_LEN",
  "R1_NO_SELF_ESTABLISH",
  "R1_ESTABLISHED",
  "R1_MERGE_EXACT",
  "R1_SHOULD_ALLOW",
  "R1_LEAK_JUDGE",
  // ↓ 判定层选型。它会改变**归并出的账本**（不是打分器），所以与 EXTRACT_MODEL 同级放在这里，
  //   而不是塞进 scorer.ts 的 R1_FLAGS。加它的原因：TypeSafe 直连会按地区 451 拒答，
  //   而 run-r1 的合并在失败时会「尽力而为」退回全 NEW —— 不记这一位，
  //   「换 provider 后的数字」和「JEV 正常时的数字」在库里长得一模一样。
  "R1_JUDGE_PROVIDER",
  "EXTRACT_THINKING",
  "EXTRACT_MODEL",
  "EXTRACT_CONCURRENCY",
  "E2E_PAD",
  "EVAL_CONTEXT",
  "EVAL_ORDER",
  "JEV_CRITERIA_MODE",
] as const;

function gitCommit(cwd: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** 所有会改变行为的指令文本，拼起来一起哈希 */
export function promptCorpus(): string {
  return [
    EXTRACTION_INSTRUCTIONS,
    CHARACTER_INSTRUCTIONS,
    PROMOTE_INSTRUCTIONS,
    MERGE_PROPOSITIONS_INSTRUCTIONS,
    BIND_MENTION_INSTRUCTIONS,
  ].join("\n\n---\n\n");
}

export function promptHash(): string {
  return createHash("sha256").update(promptCorpus()).digest("hex").slice(0, 12);
}

/** 收集当前生效的开关（未设的记为「默认」，也写进指纹，避免「忘了设」被误当成默认） */
export function flagSnapshot(overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RSI_FLAG_NAMES) {
    const v = overrides[name] ?? process.env[name];
    out[name] = v === undefined || v === "" ? "default" : v;
  }
  return out;
}

export function versionFingerprint(cwd = process.cwd(), overrides: Record<string, string> = {}): VersionFingerprint {
  const flags = flagSnapshot(overrides);
  const commit = gitCommit(cwd);
  const ph = promptHash();
  const extractModel = process.env.EXTRACT_MODEL ?? process.env.JUDGE_MODEL ?? "unknown";
  const judgeModel = process.env.JEV_MODEL ?? "jev-latest";

  const hash = createHash("sha256")
    .update(JSON.stringify({ commit, ph, extractModel, judgeModel, flags }))
    .digest("hex")
    .slice(0, 12);

  return { hash, commit, extractModel, judgeModel, promptHash: ph, flags };
}

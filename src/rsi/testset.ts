/**
 * 测试集版本注册表 —— 「结果必须与测试集版本绑定」的机制保证。
 *
 * ## 为什么必须有（这是反复吃过的亏）
 *
 * 这个项目里测试集是**一路演进**过来的：泄漏标注 3 → 10 → 14 条，剧本 23 → 31 场，
 * 《茶馆》导入器改过两版。但我此前从没把「结果」和「测试集版本」绑在一起记录，
 * 于是同一个指标在不同回合里含义不同 ——
 * 60.4%、47.9%、54.2% 三个 e2e 数字，事后才发现是配置/测试集不同造成的。
 *
 * ## 借用的成熟实践
 *
 * 1. **lm-evaluation-harness**：每个 task 带 `version` 字段，数据集或打分逻辑一变就升版本，
 *    这样「同一个 task 名下的两个分数」永远不会被混为一谈。
 * 2. **Eval Factsheets**（arXiv 2512.04062）：评测要结构化记录
 *    —— 配置、数据来源、指标定义、已知限制，缺一项就无法复核。
 * 3. **动态/滚动刷新**（ACL 2026 GEM）：静态测试集迟早被调参污染，
 *    所以留出集要封存、要计数解封次数，且必须能随时换新集。
 *
 * ## 硬规则
 *
 * - 测试集内容哈希变化 → **必须**升版本号，旧版本记录保留。
 * - 任何评测产出（`runs/<id>/result.json`、`eval/baseline/regression.json`）
 *   都要写入所用测试集的 `id@version#hash`。
 * - 版本号只增不减；`supersedes` 指向被替代的版本。
 *
 * 用法：
 *   npx tsx eval/testset.ts list
 *   npx tsx eval/testset.ts record leaks --changes "扩到 14 条，加 split 字段" --source "..."
 *   npx tsx eval/testset.ts verify        # 检查注册表里的 hash 与文件现状是否一致
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", ".."); // 本文件在 src/rsi/ 下
const REGISTRY = join(root, "evalsets", "index.json");

export interface TestSetEntry {
  id: string;
  version: number;
  createdAt: string;
  supersedes: number | null;
  /** 构成这个测试集的文件（相对路径） */
  files: string[];
  /** 文件内容合并后的 sha256（前 12 位） */
  hash: string;
  /** 规模：units = 评分单元数（标注条数/样本数），其余口径自定 */
  size: Record<string, number>;
  /** 来源与合法性（公有领域依据、自造、注入方式…） */
  source: string;
  /** 这一版改了什么、为什么改 */
  changes: string;
  /** 留出集是否封存 */
  holdoutSealed?: boolean;
}

export interface TestSetRegistry {
  sets: TestSetEntry[];
}

export function loadRegistry(): TestSetRegistry {
  if (!existsSync(REGISTRY)) return { sets: [] };
  return JSON.parse(readFileSync(REGISTRY, "utf8")) as TestSetRegistry;
}

export function saveRegistry(reg: TestSetRegistry): void {
  mkdirSync(dirname(REGISTRY), { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), "utf8");
}

/** 内容哈希：文件按路径排序后拼接，避免注册顺序影响结果 */
export function hashFiles(files: string[]): string {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    const p = resolve(root, rel);
    h.update(rel);
    h.update(existsSync(p) ? readFileSync(p) : Buffer.from("(missing)"));
  }
  return h.digest("hex").slice(0, 12);
}

/** 某个测试集的最新版本 */
export function latest(id: string): TestSetEntry | null {
  const all = loadRegistry().sets.filter((s) => s.id === id);
  return all.length ? all.reduce((a, b) => (b.version > a.version ? b : a)) : null;
}

/** 结果里用的短标识：`leaks@3#a1b2c3d4e5f6` */
export function stamp(id: string): string | null {
  const e = latest(id);
  return e ? `${e.id}@${e.version}#${e.hash}` : null;
}

/**
 * 登记一个新版本。
 *
 * - 若内容哈希与当前版本一致 → 拒绝（没有内容变化就不该升版本，否则版本号失去意义）
 * - 否则自动 version+1，并记录 supersedes
 */
export function recordVersion(
  input: Omit<TestSetEntry, "version" | "createdAt" | "hash" | "supersedes">,
): TestSetEntry {
  const reg = loadRegistry();
  const prev = latest(input.id);
  const hash = hashFiles(input.files);
  if (prev && prev.hash === hash) {
    throw new Error(
      `${input.id} 内容未变（hash 仍是 ${hash}），无需升版本。若确实是新一版，请确认 files 列表是否漏了新文件。`,
    );
  }
  const entry: TestSetEntry = {
    ...input,
    version: (prev?.version ?? 0) + 1,
    createdAt: new Date().toISOString(),
    supersedes: prev?.version ?? null,
    hash,
  };
  reg.sets.push(entry);
  saveRegistry(reg);
  return entry;
}

/** 校验：注册表里每个「最新版本」的 hash 是否仍与文件一致 */
export function verify(): Array<{ id: string; version: number; registered: string; actual: string; ok: boolean }> {
  const ids = [...new Set(loadRegistry().sets.map((s) => s.id))];
  return ids.map((id) => {
    const e = latest(id)!;
    const actual = hashFiles(e.files);
    return { id, version: e.version, registered: e.hash, actual, ok: e.hash === actual };
  });
}

// ─────────────────────────── CLI ───────────────────────────

function isMain(): boolean {
  return process.argv[1]?.endsWith("testset.ts") ?? false;
}

if (isMain()) {
  const cmd = process.argv[2] ?? "list";
  const argOf = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };

  if (cmd === "list") {
    const reg = loadRegistry();
    if (reg.sets.length === 0) {
      console.log("注册表为空。用 record 登记第一版。");
    } else {
      for (const e of reg.sets) {
        console.log(
          `${e.id}@${e.version}#${e.hash}  ${e.createdAt.slice(0, 10)}  ` +
            `units=${e.size.units ?? "?"}${e.holdoutSealed ? "  [holdout 封存]" : ""}  ← v${e.supersedes ?? "—"}`,
        );
      }
    }
  } else if (cmd === "record") {
    const id = process.argv[3];
    if (!id) throw new Error("用法：testset.ts record <id> --files a,b --units N --source ... --changes ...");
    const files = (argOf("files") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) throw new Error("--files 必填（逗号分隔的相对路径）");
    const e = recordVersion({
      id,
      files,
      size: { units: Number(argOf("units") ?? 0) },
      source: argOf("source") ?? "",
      changes: argOf("changes") ?? "",
      holdoutSealed: process.argv.includes("--holdout-sealed"),
    });
    console.log(`${e.id}@${e.version}#${e.hash} 已登记（supersedes v${e.supersedes ?? "—"}）`);
  } else if (cmd === "verify") {
    const rows = verify();
    let bad = 0;
    for (const r of rows) {
      console.log(`${r.ok ? "✓" : "✗"} ${r.id}@${r.version}  登记 ${r.registered}  实际 ${r.actual}`);
      if (!r.ok) bad += 1;
    }
    console.log(bad === 0 ? "\n全部一致。" : `\n${bad} 个不一致 —— 内容变了但没升版本，或 files 列表漏了文件。`);
    process.exitCode = bad === 0 ? 0 : 1;
  } else {
    console.log("可用：list / record / verify");
  }
}

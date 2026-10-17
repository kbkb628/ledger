/**
 * R1 审计 —— 剧本 → 账本 → 泄漏问题清单。
 *
 * **这是产品的第一条、也是唯一一条用户路径：**
 *   剧本 → 账本 → 「第 12 场，苏婉说了『当年码头那件事』，但她在 S11-01 之前并不知道码头事件」
 *
 * 用法：
 *   npm run audit                  # 用缓存（out/pipeline-r1.json），不花钱
 *   npm run audit -- --fresh       # 重跑抽取 + 归并（约 $0.035 / 35s）
 *   npm run audit -- --all         # 打印全部 usage 与知识状态，排查用
 *
 * ## 第一版刻意「不加任何豁免」
 *
 * 封闭世界假设（没记到就是不知道）会天然误报：角色可能通过别人转述、
 * 旁听、常识推断知道某件事，而剧本没有明确演出。
 * 所以先让误报全部暴露出来 —— 逐条看原因再决定要不要建「默认知识层」，
 * 比凭直觉预先加豁免规则可靠得多。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildKnowledge, buildUsages, defaultKnowledge, detectLeaks } from "../src/audit/r1.js";
import { extractScenes, type ExtractResult } from "../src/extraction/extractor.js";
import { mergeScenes, type MergeResult } from "../src/extraction/merge.js";
import { parseScenes } from "../src/extraction/script.js";
import { JevProvider } from "../src/judgment/jev-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.AUDIT_CACHE ?? join(here, "out", "pipeline-r1.json");

interface CacheShape { extracted: ExtractResult; merged: MergeResult }

function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function loadCache(): Promise<CacheShape> {
  if (!process.argv.includes("--fresh") && existsSync(CACHE)) {
    return JSON.parse(readFileSync(CACHE, "utf8")) as CacheShape;
  }
  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  console.log(`【第 0 层】抽取 ${scenes.length} 场（含知识变化）`);
  const extracted = await extractScenes(scenes, { verbose: true });

  console.log(`\n【第 1 层】归并`);
  const merged = await mergeScenes(extracted.scenes, scenes, {
    provider: new JevProvider(),
    verbose: false,
  });

  const cache: CacheShape = { extracted, merged };
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache, null, 2), "utf8");
  return cache;
}

async function main(): Promise<void> {
  loadEnv(join(here, "..", ".env"));
  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  const sceneOrder = new Map(scenes.map((s, i) => [s.id, i]));
  const cache = await loadCache();
  const { extracted, merged } = cache;
  const ledger = merged.propositions;

  console.log(`\n${"─".repeat(64)}`);
  console.log(`账本     : ${ledger.length} 条命题 · ${ledger.reduce((a, p) => a + p.aliases.length, 0)} 条说法`);
  console.log(
    `知识变化 : ${extracted.knowledgeDeltas} 条` +
      `${extracted.rejectedDeltas ? `（原文可查校验拦掉 ${extracted.rejectedDeltas} 条）` : ""}`,
  );

  const { usages, droppedShort } = buildUsages(ledger, scenes);
  const { facts, unresolved } = buildKnowledge(ledger, extracted.scenes);
  // 隔离实验用：AUDIT_NO_DEFAULT=1 关掉默认知识层，看这一条规则单独贡献多少
  const useDefaults = !process.env.AUDIT_NO_DEFAULT;
  const defaults = useDefaults ? defaultKnowledge(ledger, scenes) : [];
  for (const d of defaults) {
    facts.push({ ...d, kind: "learns", evidence: "(默认:施事/在场)" });
  }

  console.log(`使用点   : ${usages.length} 处（说话人明确的台词引用；${droppedShort} 个过短说法被跳过）`);
  console.log(
    `知识状态 : ${facts.length} 条（抽取 ${facts.length - defaults.length} + 默认层 ${defaults.length}）` +
      `${unresolved.length ? `，${unresolved.length} 条解析不到命题` : ""}`,
  );

  if (unresolved.length) {
    console.log(`\n⚠️ 解析不到命题的知识变化（about 在本场没有对应说法）:`);
    for (const u of unresolved.slice(0, 10)) console.log(`  ${u.scene} ${u.character}：「${u.about}」`);
    if (unresolved.length > 10) console.log(`  …另有 ${unresolved.length - 10} 条`);
  }

  const issues = detectLeaks(ledger, usages, facts, sceneOrder);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`R1 知识泄漏问题清单（${issues.length} 条）`);
  console.log(`${"═".repeat(64)}`);

  if (issues.length === 0) {
    console.log(`\n  没有检出泄漏。\n`);
  }

  for (const [i, iss] of issues.entries()) {
    console.log(`\n[${i + 1}] ${iss.useScene}　${iss.character} 用到了「${iss.surface}」`);
    console.log(`    命题：${iss.canonical}`);
    console.log(`    原文：${iss.line}`);
    console.log(
      iss.knownAt === null
        ? `    ⚠️ 全剧没有记录 ${iss.character} 得知过这条命题 → 疑似知识泄漏`
        : `    ⚠️ ${iss.character} 到 ${iss.knownAt} 才得知这条命题，却在 ${iss.useScene} 就用了`,
    );
  }

  if (process.argv.includes("--all")) {
    console.log(`\n${"─".repeat(64)}\n全部知识状态（mind）:`);
    for (const k of facts) console.log(`  ${k.scene}  ${k.character} ${k.kind} → ${k.propositionId}（证据：「${k.evidence}」）`);
    console.log(`\n全部使用点:`);
    for (const u of usages) console.log(`  ${u.scene}  ${u.character} 「${u.surface}」→ ${u.propositionId}`);
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`成本: 抽取 $${extracted.costUsd.toFixed(4)} + 归并 $${merged.costUsd.toFixed(4)}`);
  console.log(`\n⚠️ 第一版刻意不加任何豁免 —— 误报是这份清单的一部分，需逐条核对原因。\n`);
}

await main();

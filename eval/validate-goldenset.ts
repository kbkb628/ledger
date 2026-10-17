/**
 * 黄金集机械校验 —— 「模型提议，代码验证」里的验证那一半。
 *
 * 黄金集是全项目的**度量基准**，它自己出错会让后面所有实验结论失真
 * （rsi-log.md 的效度教训就是这么来的：旧集混进了剧本里根本没出现的「手写关键词」）。
 * 所以每次重标都必须过一遍这台机器。
 *
 * 用法：
 *   npx tsx eval/validate-goldenset.ts                       # 校验 goldenset.json
 *   npx tsx eval/validate-goldenset.ts eval/goldenset-v3.json
 *
 * ## 五条检查
 *
 * | # | 检查 | 违反后果 |
 * |---|---|---|
 * | 1 | 每条别名的说法**逐字出现在剧本里** | 等于「手写提示词」，指标虚假 |
 * | 2 | `first_seen` 等于该说法的**真实首见场景** | 时序过滤失效，泄露未来信息 |
 * | 3 | 样本的 mention 字段与基准集**一字不差** | 换了题却比分数 |
 * | 4 | 每个样本的 `gold` 非空且 id 存在 | 评测脚本静默算错 |
 * | 5 | 命题 id 唯一、无空 canonical | 归并/指派行为未定义 |
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseScenes } from "../src/extraction/script.js";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "goldenset.json");
const baseline = join(here, "goldenset.json");

interface Alias { surface: string; first_seen: string }
interface Proposition {
  id: string;
  canonical: string;
  aliases: Alias[];
  audit_unit?: string;
  splits_from?: string[];
}
interface Sample {
  id: string;
  mention: { surface: string; scene: string; kind: string; context: string };
  gold: string[];
}
interface GoldenSet {
  meta: { name: string; size?: number };
  propositions: Proposition[];
  samples: Sample[];
}

const strip = (s: string): string => s.replace(/\s+/g, "");

function main(): void {
  const golden = JSON.parse(readFileSync(target, "utf8")) as GoldenSet;
  const scenes = parseScenes(readFileSync(join(here, "script-jiuzhang.md"), "utf8"));
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, i]));
  const sceneText = new Map(scenes.map((s) => [s.id, strip(s.lines.join("\n"))]));
  const allText = strip(scenes.map((s) => s.lines.join("\n")).join("\n"));

  const errors: string[] = [];
  const warnings: string[] = [];

  console.log(`\n黄金集校验 · ${target}`);
  console.log(`  ${golden.meta.name}`);
  console.log(`  ${golden.propositions.length} 条命题 / ${golden.samples.length} 个样本\n`);

  // ── 1 & 2：别名的原文可查性与首见场景 ──
  let aliasTotal = 0;
  let notFound = 0;
  let firstSeenWrong = 0;
  for (const p of golden.propositions) {
    for (const a of p.aliases) {
      aliasTotal += 1;
      const needle = strip(a.surface);
      if (!needle) {
        errors.push(`${p.id} 有空别名`);
        continue;
      }
      if (!allText.includes(needle)) {
        errors.push(`${p.id}「${a.surface}」在剧本里找不到（不得改写或自造）`);
        notFound += 1;
        continue;
      }
      // 真实首见场景 = 按剧本顺序第一个包含该说法的场景
      const real = scenes.find((s) => (sceneText.get(s.id) ?? "").includes(needle))?.id;
      if (real && real !== a.first_seen) {
        const labeled = sceneIndex.get(a.first_seen) ?? -1;
        const actual = sceneIndex.get(real) ?? -1;
        // ⚠️ 方向很重要：
        //   标晚了 → 评测时可用别名被**少算**，偏保守，结论仍成立
        //   标早了 → 处理早期样本时暴露了未来才出现的说法，**泄露未来信息**，必须当错误
        if (labeled < actual) {
          errors.push(
            `${p.id}「${a.surface}」first_seen=${a.first_seen} 早于实际首见 ${real} —— ⚠️ 泄露未来信息`,
          );
        } else {
          warnings.push(
            `${p.id}「${a.surface}」first_seen=${a.first_seen} 晚于实际首见 ${real}（偏保守，会少算可用别名）`,
          );
        }
        firstSeenWrong += 1;
      }
      if (a.first_seen && !sceneIndex.has(a.first_seen)) {
        errors.push(`${p.id}「${a.surface}」first_seen=${a.first_seen} 不是合法场景 id`);
      }
    }
  }

  // ── 3：样本的 mention 必须与基准集一字不差 ──
  if (target !== baseline) {
    try {
      const base = JSON.parse(readFileSync(baseline, "utf8")) as GoldenSet;
      const baseById = new Map(base.samples.map((s) => [s.id, s]));
      if (base.samples.length !== golden.samples.length) {
        errors.push(`样本数从 ${base.samples.length} 变成 ${golden.samples.length}`);
      }
      for (const s of golden.samples) {
        const b = baseById.get(s.id);
        if (!b) {
          errors.push(`${s.id} 在基准集里不存在（不得新增样本 id）`);
          continue;
        }
        for (const f of ["surface", "scene", "kind", "context"] as const) {
          if (s.mention[f] !== b.mention[f]) {
            // ⚠️ 这是警告不是错误：v3 有意修复了 v2 里 4 个**说法在剧本中根本不存在**的样本。
            // 但要显式列出，防止有人悄悄换题。
            warnings.push(`${s.id} 的 mention.${f} 被改动：「${b.mention[f]}」→「${s.mention[f]}」`);
          }
        }
      }
      const missing = base.samples.filter((b) => !golden.samples.some((s) => s.id === b.id));
      for (const m of missing) errors.push(`${m.id} 在目标集里丢失`);
    } catch {
      warnings.push("找不到基准集，跳过 mention 一致性检查");
    }
  }

  // ── 4：样本的 gold 合法性 ──
  const ids = new Set(golden.propositions.map((p) => p.id));
  const SPECIAL = new Set(["NEW", "UNSURE"]);
  let specialCount = 0;
  const mentionNotInScript: string[] = [];
  const contextNotInScript: string[] = [];
  for (const s of golden.samples) {
    if (!Array.isArray(s.gold) || s.gold.length === 0) {
      errors.push(`${s.id} 的 gold 为空`);
      continue;
    }
    for (const g of s.gold) {
      if (SPECIAL.has(g)) { specialCount += 1; continue; }
      if (!ids.has(g)) errors.push(`${s.id} 的 gold 指向不存在的命题 ${g}`);
    }
    // 样本的 mention 必须是剧本里真实存在的说法 —— 否则测的是「绑定一个不存在的句子」
    const sceneTxt = sceneText.get(s.mention.scene) ?? "";
    if (!sceneTxt.includes(strip(s.mention.surface))) {
      mentionNotInScript.push(`${s.id}「${s.mention.surface}」@${s.mention.scene}`);
    }
    if (s.mention.context && !allText.includes(strip(s.mention.context))) {
      contextNotInScript.push(`${s.id}@${s.mention.scene}`);
    }
  }
  if (mentionNotInScript.length) {
    errors.push(
      `${mentionNotInScript.length} 个样本的 mention 说法不在剧本原文里：${mentionNotInScript.join("、")}`,
    );
  }
  if (contextNotInScript.length) {
    warnings.push(`${contextNotInScript.length} 个样本的 context 不是剧本原文：${contextNotInScript.join("、")}`);
  }

  // ── 5：命题自检 ──
  const seen = new Set<string>();
  for (const p of golden.propositions) {
    if (seen.has(p.id)) errors.push(`命题 id 重复：${p.id}`);
    seen.add(p.id);
    if (!p.canonical?.trim()) errors.push(`${p.id} 的 canonical 为空`);
    if (p.aliases.length === 0) warnings.push(`${p.id} 没有任何别名（判定层拿不到字面线索）`);
  }

  // 未被任何样本引用的命题
  const referenced = new Set(golden.samples.flatMap((s) => s.gold).filter((g) => !SPECIAL.has(g)));
  const orphan = golden.propositions.filter((p) => !referenced.has(p.id)).map((p) => p.id);
  if (orphan.length) warnings.push(`没有任何样本引用的命题：${orphan.join(", ")}（不算错，但确认一下是否多余）`);

  // ── 汇总 ──
  console.log(`别名可查性   : ${aliasTotal - notFound}/${aliasTotal} 逐字命中原文`);
  console.log(`首见场景正确 : ${aliasTotal - notFound - firstSeenWrong}/${aliasTotal - notFound}`);
  console.log(`样本         : ${golden.samples.length} 个（其中 ${specialCount} 个字面量负例 NEW/UNSURE）`);
  console.log(`命题         : ${golden.propositions.length} 条（${orphan.length} 条无样本引用）`);
  console.log(`差异 / 警告  : ${errors.length} / ${warnings.length}`);

  if (warnings.length) {
    console.log(`\n⚠️ 警告:`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (errors.length) {
    console.log(`\n❌ 错误:`);
    for (const e of errors.slice(0, 60)) console.log(`  ${e}`);
    if (errors.length > 60) console.log(`  …另有 ${errors.length - 60} 条`);
    console.log(`\n校验不通过。\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ 校验通过。\n`);
}

main();

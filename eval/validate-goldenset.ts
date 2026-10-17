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
 *   npx tsx eval/validate-goldenset.ts eval/leaks-jiuzhang.json   # 泄漏标注集（schema 不同，见 validateLeaks）
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

// ─────────────────── 泄漏标注集（eval/leaks*.json）也有自己的一套机械校验 ───────────────────
//
// 为什么单开一段：泄漏集的错误方式与黄金集不同 —— 最致命的是「注入的台词其实出自
// 泄漏者自己的嘴」（首见场景在场者得知会把它自己掩盖掉）和「事实在该角色的场景里才第一次
// 出现，所以根本不是泄漏」。这两条都能用剧本原文机械判定，不靠人眼。

interface LeakAnnotation {
  id: string;
  kind: "no_source" | "timing";
  character: string;
  scene: string;
  surface: string;
  why: string;
  exact_scene: boolean;
  split: "dev" | "holdout";
  /** 泄漏事实在那里确立（该角色必须不在场） */
  established?: string;
  /** timing 类：该角色真正知情的场景（必须晚于泄漏场景，且该角色在场） */
  learns_at?: string;
}

interface LeaksFile {
  meta: { name: string; script?: string };
  leaks: LeakAnnotation[];
  must_not_flag: Array<{ character: string; scene: string; surface: string; why: string }>;
}

/** 从场次元数据行里取「在场：A、B」 */
function presence(scene: { meta: string[] }): Set<string> {
  const out = new Set<string>();
  for (const m of scene.meta) {
    const hit = /在场[:：]\s*([^·]*)/.exec(m);
    if (!hit) continue;
    for (const name of hit[1]!.split(/[、,，\/]/)) {
      // 去掉「陈默（病床）」这类注记，名字本身才是判定依据
      const n = name.replace(/[（(][^）)]*[）)]/g, "").trim();
      if (n) out.add(n);
    }
  }
  return out;
}

function validateLeaks(file: LeaksFile): void {
  const scriptPath = process.env.R1_SCRIPT ?? join(here, "..", file.meta.script ?? "eval/script-jiuzhang-leak.md");
  const scenes = parseScenes(readFileSync(scriptPath, "utf8"));
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, i]));
  const sceneText = new Map(scenes.map((s) => [s.id, strip(s.lines.join("\n"))]));
  const scenePresence = new Map(scenes.map((s) => [s.id, presence(s)]));
  const allText = strip(scenes.map((s) => s.lines.join("\n")).join("\n"));

  const errors: string[] = [];
  const warnings: string[] = [];

  console.log(`\n泄漏标注校验 · ${target}`);
  console.log(`  ${file.meta.name}`);
  console.log(`  剧本 ${scriptPath} · ${scenes.length} 场`);
  console.log(
    `  ${file.leaks.length} 条泄漏 / ${file.must_not_flag.length} 条应当放过 · ` +
      `split dev=${file.leaks.filter((l) => l.split === "dev").length} holdout=${file.leaks.filter((l) => l.split === "holdout").length}\n`,
  );

  const ids = new Set<string>();
  for (const a of file.leaks) {
    if (ids.has(a.id)) errors.push(`泄漏 id 重复：${a.id}`);
    ids.add(a.id);
    if (a.kind !== "no_source" && a.kind !== "timing") errors.push(`${a.id} 的 kind 非法：${a.kind}`);
    if (a.split !== "dev" && a.split !== "holdout") errors.push(`${a.id} 的 split 非法：${a.split}`);

    const at = sceneIndex.get(a.scene);
    if (at === undefined) {
      errors.push(`${a.id} 的场景 ${a.scene} 不在剧本里`);
      continue;
    }
    // 1. 注入的说法必须逐字出现在**该场景**里（不是剧本任意处 —— 否则可能匹配到原句）
    if (!(sceneText.get(a.scene) ?? "").includes(strip(a.surface))) {
      errors.push(`${a.id}「${a.surface}」不在 ${a.scene} 的原文里（注入没生效，或 surface 抄错）`);
    } else if (!allText.includes(strip(a.surface))) {
      errors.push(`${a.id}「${a.surface}」不在剧本原文里`);
    }
    // 2. 泄漏者必须在这个场景里（否则这条「使用点」根本不该存在）
    if (!scenePresence.get(a.scene)?.has(a.character)) {
      errors.push(`${a.id} ${a.character} 不在 ${a.scene} 的在场名单里（这条泄漏无从发生）`);
    }
    // 3. 事实的确立场景必须更早，且泄漏者不在场
    if (!a.established) {
      warnings.push(`${a.id} 没标 established，无法机械校验「事实在别处确立」`);
    } else {
      const est = sceneIndex.get(a.established);
      if (est === undefined) errors.push(`${a.id} 的 established=${a.established} 不在剧本里`);
      else {
        if (est >= at) {
          errors.push(`${a.id} 的 established=${a.established} 不早于泄漏场景 ${a.scene}（时序上不是「更早确立」）`);
        }
        if (scenePresence.get(a.established)?.has(a.character)) {
          errors.push(
            `${a.id} 的 established=${a.established} 里 ${a.character} 在场 —— 会被「首见场景在场者得知」掩盖`,
          );
        }
        if (!(sceneText.get(a.established) ?? "").includes(strip(a.surface))) {
          warnings.push(`${a.id} 的 established=${a.established} 原文里没有「${a.surface}」（别名可能不同，人工确认）`);
        }
      }
    }
    // 4. timing 类必须给出「真正知情」的场景：更晚，且该角色在场
    if (a.kind === "timing") {
      if (!a.learns_at) {
        errors.push(`${a.id} 是 timing 但没有 learns_at`);
      } else {
        const learn = sceneIndex.get(a.learns_at);
        if (learn === undefined) errors.push(`${a.id} 的 learns_at=${a.learns_at} 不在剧本里`);
        else {
          if (learn <= at) errors.push(`${a.id} 的 learns_at=${a.learns_at} 不晚于泄漏场景（就不是时序泄漏了）`);
          if (!scenePresence.get(a.learns_at)?.has(a.character)) {
            errors.push(`${a.id} 的 learns_at=${a.learns_at} 里 ${a.character} 不在场（他并没有在那时知情）`);
          }
        }
      }
    }
  }

  // 5. 应当放过的台词同样要在原文里、且该角色在场
  const seen = new Set<string>();
  for (const m of file.must_not_flag) {
    const key = `${m.character}|${m.surface}`;
    if (seen.has(key)) warnings.push(`must_not_flag 重复：${key}`);
    seen.add(key);
    if (m.scene && !sceneIndex.has(m.scene)) errors.push(`must_not_flag ${key} 的场景 ${m.scene} 不在剧本里`);
    if (!sceneText.get(m.scene)?.includes(strip(m.surface))) {
      errors.push(`must_not_flag ${key}「${m.surface}」不在 ${m.scene} 的原文里`);
    }
    if (m.scene && !scenePresence.get(m.scene)?.has(m.character)) {
      errors.push(`must_not_flag ${key} 的 ${m.character} 不在 ${m.scene} 的在场名单里`);
    }
    if (!m.why?.trim()) errors.push(`must_not_flag ${key} 缺 why（「为什么该放过」是这条标注的全部价值）`);
  }

  const timing = file.leaks.filter((l) => l.kind === "timing").length;
  console.log(`泄漏类型     : 无源 ${file.leaks.length - timing} / 时序 ${timing}`);
  console.log(`应当放过     : ${file.must_not_flag.length} 条（含施事、当事人、重生者预知、当场看到）`);
  console.log(`差异 / 警告  : ${errors.length} / ${warnings.length}`);

  if (warnings.length) {
    console.log(`\n⚠️ 警告:`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (errors.length) {
    console.log(`\n❌ 错误:`);
    for (const e of errors) console.log(`  ${e}`);
    console.log(`\n校验不通过。\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ 校验通过。\n`);
}

function main(): void {
  const raw = readFileSync(target, "utf8");
  const parsed = JSON.parse(raw) as Partial<GoldenSet> & Partial<LeaksFile>;
  if (Array.isArray(parsed.leaks) && !Array.isArray(parsed.propositions)) {
    validateLeaks(parsed as LeaksFile);
    return;
  }
  const golden = parsed as GoldenSet;
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

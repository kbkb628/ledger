/**
 * 《竇娥冤》（關漢卿，元）→ 本项目的剧本 markdown 格式。
 *
 * ## 为什么加这一套
 *
 * `real`（真实剧本零标注误报）目前只有《茶馆》一本 —— 7 条 / 269 使用点是不是「茶馆特性」，
 * 单本看不出来。元杂剧是**完全另一套写法**（曲牌唱词 + 科白，`〔正旦做嘆科，云〕` 这种混合标记），
 * 同一套规则在它上面报多少，是对 `real` 的第一份跨剧本压力测试。
 *
 * 版权：關漢卿（约 1220–1300），公有领域。
 *
 * ## 原始文本怎么取
 *
 * ```bash
 * curl "https://zh.wikisource.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=%E7%AB%87%E5%A8%A5%E5%86%A4&format=json&redirects=1"
 * ```
 * 取 `query.pages[*].extract`，存成 UTF-8 文本（默认路径见下）。本脚本只做**纯转换**，不联网。
 *
 * 用法：`npx tsx eval/import-doueyuan.ts [raw.txt] [out.md]`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] ?? join(here, "out", "doueyuan-raw.txt");
const OUT = process.argv[3] ?? join(here, "script-doueyuan.md");

/** 场上角色 → 本项目的人物名（同一人的不同家门身份要归一，否则知识记录会分裂） */
const ROLES: Record<string, string> = {
  正旦: "竇娥",
  旦: "竇娥",
  魂旦: "竇娥",
  卜兒: "蔡婆婆",
  蔡婆: "蔡婆婆",
  沖末: "竇天章",
  竇天章: "竇天章",
  張驢兒: "張驢兒",
  賽盧醫: "賽盧醫",
  孛老: "張父",
  孤: "州官",
  州官: "州官",
  監斬官: "監斬官",
  張千: "張千",
  劊子: "劊子",
  祗候: "祗候",
};

const SCENE_TITLES: Record<string, string> = {
  楔子: "楔子",
  第一折: "第一折",
  第二折: "第二折",
  第三折: "第三折",
  第四折: "第四折",
};

/** 把「正旦做嘆科，云」「卜兒上，云」「張驢兒做避科」这类提示语解析成 {角色, 是否发话} */
function parseCue(cue: string): { speaker?: string; speaks: boolean; action: string } {
  const action = cue.trim();
  const speaks = /云|唱|白/.test(action);
  // 角色名不一定在提示语开头，元杂剧常写成「做相見科。竇天章云」「沖末扮竇天章引正旦扮端雲上，詩云」。
  // 取**最早出现的角色名**当作发话人：这类提示语的主语在前，后面的角色是跟着上场的。
  let best: { role: string; at: number } | null = null;
  for (const key of Object.keys(ROLES)) {
    const at = action.indexOf(key);
    if (at >= 0 && (!best || at < best.at)) best = { role: key, at };
  }
  if (best) return { speaker: ROLES[best.role], speaks, action };
  return { speaks: false, action };
}

function main(): void {
  if (!existsSync(RAW)) throw new Error(`找不到原始文本：${RAW}`);
  const text = readFileSync(RAW, "utf8");

  // 1. 按「== 楔子 ==」「== 第一折 ==」切场
  const parts = text.split(/^==\s*([^=]+?)\s*==\s*$/m);
  const scenes: Array<{ title: string; body: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i]!.trim();
    scenes.push({ title, body: parts[i + 1] ?? "" });
  }
  if (scenes.length === 0) throw new Error("没有解析到任何「== 楔子/第X折 ==」标题");

  const out: string[] = [
    "# 《竇娥冤》— 真实剧本测试材料（第二套，跨剧本 real）",
    "",
    "> 關漢卿，元。**公有领域**。由 `eval/import-doueyuan.ts` 从 Wikisource 转录页",
    "> （https://zh.wikisource.org/wiki/竇娥冤）转换；本仓库随 MIT 一并提供（`LICENSE`）。",
    ">",
    "> **用途：第二套零标注真实剧本。**《茶馆》是话剧（对白 + 少量舞台提示），",
    "> 这一本是元杂剧（曲牌唱词 + 科白混排），两套一起报数，才看得出 `real` 是不是单本特性。",
    "",
    "---",
    "",
  ];

  let lineCount = 0;
  let speakerLines = 0;
  scenes.forEach((sc, idx) => {
    const act = `D-${String(idx + 1).padStart(2, "0")}`;
    const label = SCENE_TITLES[sc.title] ?? sc.title;
    // 2. 逐段扫：`〔…〕` 是提示语/科白标记，括号外是台词正文
    const tokens: Array<{ kind: "cue" | "speech"; value: string }> = [];
    const body = sc.body.replace(/\r/g, "");
    let last = 0;
    const re = /〔([^〕]*)〕/g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const before = body.slice(last, m.index);
      if (before.trim()) tokens.push({ kind: "speech", value: before });
      tokens.push({ kind: "cue", value: m[1]! });
      last = m.index + m[0].length;
    }
    const tailText = body.slice(last);
    if (tailText.trim()) tokens.push({ kind: "speech", value: tailText });

    // 3. 场内再切场：遇到「上/下」这类上下场标记就断开。
    //
    // 为什么必须切（回合 47 自检发现）：一折当一场时「在场」= 整折十几个人物同时在场，
    // 于是「命题首见场景的在场者得知它」把 121 个使用点里的 104 个（86%）全发了许可 ——
    // 结果既零误报也零检出，这套集就失去了压力测试的意义。按上下场切开，
    // 在场名单才接近「此刻台上的人」，与《茶馆》的分场口径可比。
    const isBoundary = (cue: string): boolean =>
      /(^|[，。、])[上下]([，。、]|$)/.test(cue) || /[上下]$/.test(cue.trim());

    const subs: string[][] = [[]];
    let current: string | null = null;
    for (const tk of tokens) {
      const target = subs[subs.length - 1]!;
      if (tk.kind === "cue") {
        if (isBoundary(tk.value) && target.length > 0) {
          subs.push([]);
          current = null;
          continue;
        }
        const parsed = parseCue(tk.value);
        if (parsed.speaker && parsed.speaks) current = parsed.speaker;
        else if (parsed.speaker) target.push(`（${parsed.action}）`);
        continue;
      }
      const text2 = tk.value.replace(/\s+/g, "");
      if (!text2) continue;
      if (current) {
        target.push(`${current}：${text2}`);
        speakerLines += 1;
      } else {
        target.push(text2.startsWith("（") ? text2 : `（${text2}）`);
      }
    }

    subs
      .filter((s) => s.length > 0)
      .forEach((s, k) => {
        // 在场：从本场说过台词的说话人反推（零人工标注、可复现）。
        // 它是「命题首见场景的在场者得知它」这条默认知识的唯一来源，口径必须与台词一致。
        const present: string[] = [];
        for (const l of s) {
          const m = /^([^：（）]{1,6})：/.exec(l);
          if (m && !present.includes(m[1]!)) present.push(m[1]!);
        }
        lineCount += s.length;
        out.push(
          `## ${act}-${String(k + 1).padStart(2, "0")}`,
          `- 时间锚：${label} · 地点：（未标注） · 在场：${present.join("、")}`,
          "",
          ...s,
          "",
          "---",
          "",
        );
      });
  });

  writeFileSync(OUT, out.join("\n"), "utf8");
  const sceneCount = out.filter((l) => /^## /.test(l)).length;
  console.log(`写入 ${OUT}：${sceneCount} 场 / ${lineCount} 行（其中 ${speakerLines} 行带说话人）`);
}
main();

/**
 * 把 Wikisource 的《茶馆》（老舍，1957）wikitext 转成本项目剧本格式。
 *
 * ## 为什么用《茶馆》
 *
 * 1. **确定公有领域**：老舍 1966 年去世，中国著作权法保护期至第 50 年底，2017 年届满。
 * 2. **专业剧本、天然自洽** —— 这正好给了我一个**零标注的精确率测试集**：
 *    在真实剧本上跑 R1，报出来的「泄漏」几乎都是误报（跟我在《旧账》正本上遇到的一样），
 *    但这次的分布是真实戏剧的分布，不是我自己编的。
 * 3. **跨幕知识状态极丰富**：七十多个人物、三幕跨五十年，
 *    「只有前文在场的人才该知道的事」遍地都是。
 *
 * ## 解析难点
 *
 * Wikisource 的转录把**说话人直接粘在台词前**：「王利发唐先生，你外边蹓跶吧！」
 * 没有冒号分隔。所以先取「人物」表，再用**最长前缀匹配**切出说话人。
 * 解析不追求完美 —— 目标是一份难度真实的测试材料，不是校勘本。
 *
 * 用法：npx tsx eval/import-chaguan.ts
 * 产出：eval/script-chaguan.md（本项目剧本格式）、eval/external/chaguan-stats.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "external");
const OUT = join(here, "script-chaguan.md");

interface Paragraph {
  kind: "narration" | "dialogue";
  text: string;
  speaker?: string;
}

/** 清掉 wikitext 标记 */
function clean(raw: string): string {
  let t = raw;
  t = t.replace(/\{\{[\s\S]*?\}\}/g, "");
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/^=+.*?=+$/gm, "");
  t = t.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1");
  t = t.replace(/'''?/g, "");
  t = t.replace(/<[^>]+>/g, "");
  return t.trim();
}

/**
 * 人物表：**人工整理**，不靠自动切分。
 *
 * 原因：Wikisource 的转录里，第一幕的人物表用空白分隔（可自动解析），
 * 而第二、三幕是**连写无分隔**的（`人物王淑芬报童康顺子李三常四爷`、`王大拴明师傅于厚斋…`），
 * 自动切分必然出错。所以按剧目人物表人工列一份，只收**具体人名**，
 * 排除「难民数人」「押大令的兵七人」「茶客甲、乙」这类群体标签。
 *
 * 这份 roster 只影响「说话人切分」与「在场」字段，不影响文本本身。
 */
const ROSTER: Record<string, string[]> = {
  xumu: ["王利发", "康六", "康顺子", "刘麻子", "庞太监", "乡妇", "小妞", "茶客"],
  act1: [
    "王利发", "刘麻子", "庞太监", "唐铁嘴", "康六", "小牛儿", "松二爷", "黄胖子",
    "宋恩子", "常四爷", "秦仲义", "吴祥子", "李三", "老人", "康顺子", "二德子",
    "乡妇", "小妞", "马五爷", "茶客",
  ],
  act2: [
    "王淑芬", "报童", "康顺子", "李三", "常四爷", "康大力", "王利发", "松二爷",
    "老林", "宋恩子", "老陈", "巡警", "吴祥子", "崔久峰", "军官", "茶客",
  ],
  act3: [
    "王大拴", "明师傅", "于厚斋", "周秀花", "邹福远", "宋恩子", "王小花", "卫福喜",
    "小吴祥子", "康顺子", "方六", "常四爷", "丁宝", "车当当", "秦仲义", "王利发",
    "庞四奶奶", "小心眼", "春梅", "沈处长", "小刘麻子", "老杨", "宪兵", "茶客",
  ],
};

/** 兜底：从「人物」段尽力提取（第一幕可用），与人工表合并 */
function parseCharacters(paragraphs: string[]): string[] {
  const start = paragraphs.findIndex((p) => /^人物[\s：:]/.test(clean(p)));
  if (start < 0) return [];
  const names: string[] = [];
  for (let i = start; i < paragraphs.length; i++) {
    const c = clean(paragraphs[i]!);
    if (i > start && c.startsWith("〔")) break;
    const body = c.replace(/^人物[\s：:]*/, "");
    for (const n of body.split(/[\s、,，]+/)) {
      const name = n.trim();
      if (name && name.length >= 2 && name.length <= 6 && !/[（）〔〕]/.test(name)) names.push(name);
    }
  }
  // 长的优先，保证「王利发」不被「王利」类短名截胡
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

/** 最长前缀匹配切说话人；返回 [speaker, rest] 或 null */
function splitSpeaker(paragraph: string, names: string[]): [string, string] | null {
  for (const n of names) {
    if (paragraph.startsWith(n)) {
      const rest = paragraph.slice(n.length).replace(/^[\s：:，,。、]*/, "");
      if (rest.length > 0) return [n, rest];
    }
  }
  return null;
}

function parseAct(raw: string, names: string[]): Paragraph[] {
  const paragraphs = raw
    .split(/\r?\n\s*\r?\n/)
    .map((p) => clean(p))
    .filter((p) => p.length > 0 && !/^[上下]场$/.test(p))
    // 去掉「时间 / 地点 / 人物」这类幕首元信息
    .filter((p) => !/^(时间|地点|人物)[\s：:]/.test(p));

  const out: Paragraph[] = [];
  for (const p of paragraphs) {
    if (p.startsWith("〔") || p.startsWith("（幕")) {
      out.push({ kind: "narration", text: p });
      continue;
    }
    let rest = p;
    let speaker: string | undefined;
    // 可能一段里连着几个「名字+台词」，逐个剥
    const first = splitSpeaker(rest, names);
    if (first) {
      speaker = first[0];
      rest = first[1]!;
    }
    if (!speaker) {
      out.push({ kind: "narration", text: p });
      continue;
    }
    out.push({ kind: "dialogue", speaker, text: rest });
  }
  return out;
}

/** 把一幕切成若干「场」：遇到叙述段且当前场已有 ≥4 句台词就断开 */
function intoScenes(paras: Paragraph[], actNo: number): Array<{ id: string; lines: string[]; present: string[] }> {
  const scenes: Array<{ id: string; lines: string[]; present: string[] }> = [];
  let lines: string[] = [];
  let speakers = new Set<string>();
  let dialogueCount = 0;
  let n = 0;

  const flush = (): void => {
    if (lines.length === 0) return;
    n += 1;
    scenes.push({
      id: `S${String(actNo).padStart(2, "0")}-${String(n).padStart(2, "0")}`,
      lines,
      present: [...speakers],
    });
    lines = [];
    speakers = new Set();
    dialogueCount = 0;
  };

  for (const p of paras) {
    if (p.kind === "narration") {
      if (dialogueCount >= 4) flush();
      lines.push(p.text);
      continue;
    }
    lines.push(`${p.speaker}：${p.text}`);
    speakers.add(p.speaker!);
    dialogueCount += 1;
  }
  flush();
  return scenes;
}

function main(): void {
  const acts = [
    { key: "xumu", no: 1, label: "序幕" },
    { key: "act1", no: 2, label: "第一幕" },
    { key: "act2", no: 3, label: "第二幕" },
    { key: "act3", no: 4, label: "第三幕" },
  ];

  const out: string[] = [
    "# 《茶馆》— 真实剧本测试材料",
    "",
    "> 老舍，1957。**公有领域**（作者 1966 年去世，中国著作权法保护期至 2016 年底）。",
    "> 由 `eval/import-chaguan.ts` 从 Wikisource 转录文本自动转换，仅用于本项目的评测。",
    ">",
    "> **用途：零标注的精确率测试集。** 专业剧本是自洽的 —— 在它上面跑 R1，",
    "> 报出的「知识泄漏」几乎都是误报，但分布是真实戏剧的分布，不是自造的。",
    "",
  ];

  const stats: Record<string, unknown> = { acts: [] as unknown[] };

  for (const act of acts) {
    const p = join(EXT, `chaguan-${act.key}.wiki`);
    if (!existsSync(p)) {
      console.warn(`缺少 ${p}，跳过`);
      continue;
    }
    const raw = readFileSync(p, "utf8");
    const paras0 = raw.split(/\r?\n\s*\r?\n/);
    const auto = parseCharacters(paras0);
    const names = [...new Set([...(ROSTER[act.key] ?? []), ...auto])].sort((a, b) => b.length - a.length);
    const paras = parseAct(raw, names);
    const scenes = intoScenes(paras, act.no);

    out.push(`## ${act.label}（${scenes.length} 场，${names.length} 人物）`, "");
    for (const s of scenes) {
      out.push(`## ${s.id}`);
      out.push(`- 时间锚：${act.label} · 地点：裕泰大茶馆 · 在场：${s.present.slice(0, 10).join("、") || "（叙述）"}`);
      out.push("");
      for (const l of s.lines) out.push(l);
      out.push("");
    }

    (stats.acts as unknown[]).push({
      act: act.label,
      characters: names.length,
      paragraphs: paras.length,
      dialogue: paras.filter((x) => x.kind === "dialogue").length,
      narration: paras.filter((x) => x.kind === "narration").length,
      scenes: scenes.length,
      sampleNames: names.slice(0, 8),
    });
    console.log(`${act.label}: 人物 ${names.length} · 段落 ${paras.length} · 台词 ${paras.filter((x) => x.kind === "dialogue").length} · 场 ${scenes.length}`);
  }

  writeFileSync(OUT, `${out.join("\n")}\n`, "utf8");
  writeFileSync(join(EXT, "chaguan-stats.json"), JSON.stringify(stats, null, 2), "utf8");
  console.log(`\n已写出 ${OUT}`);
}

main();

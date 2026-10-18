// 幻影集 v2 的生成器：单一事实表 → 剧本（eval/script-phantom.md）+ 标注（eval/leaks-phantom.json）
// 为什么要生成而不是手写：60 条泄漏的「说话人是否知情 / 是否在场 / 说法是否唯一」靠人肉配对必然出错，
// 这里全部由脚本算出来并在写盘前断言。改一个事实只需要改这张表，仪器可重建。
import { writeFileSync } from "node:fs";

/* ── 事实表 ─────────────────────────────────────────────────────────────
 * estab: 确立场景 / knowers: 该场在场者（= 知情者）/ anchor: 锚定说法（= 确立场景的原话）
 * anchorLine: 沿用原话的那条泄漏句 / phantomLine: 换了说法的那条泄漏句
 */
const FACTS = [
  { id: "F-01", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "保险箱的密码是小姐的生日", anchorLine: "保险箱的密码是小姐的生日", phantomLine: "那把锁的密码，我试了两次就开了" },
  { id: "F-02", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "地窖里那箱旧账", anchorLine: "地窖里那箱旧账，我建议一起处理", phantomLine: "地底下那箱旧纸，早晚有人翻出来" },
  { id: "F-03", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "见证人收了钱", anchorLine: "老爷立遗嘱那天，见证人收了钱", phantomLine: "签遗嘱那天站在旁边的人，口袋不干净" },
  { id: "F-04", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "陆家当年那笔债，三年前就还清了", anchorLine: "陆家当年那笔债，三年前就还清了，是老爷垫的", phantomLine: "陆家的欠款，早就抹平了" },
  { id: "F-05", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "后院那口井", anchorLine: "老宅后院那口井，早年被填过，填的是水泥", phantomLine: "后边那口井，底下灌的是水泥" },
  { id: "F-06", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "太太留下的那只玉镯", anchorLine: "太太留下的那只玉镯，在保险箱最底下", phantomLine: "太太那只镯子，压在最底下" },
  { id: "F-07", estab: "P-01", knowers: ["沈知微", "陈叔"], anchor: "遗嘱改过两次", anchorLine: "老爷的遗嘱改过两次，最后一次是我经手的", phantomLine: "遗嘱改了两回，你手上是哪一版" },

  { id: "F-08", estab: "P-02", knowers: ["苏婉", "陆见深"], anchor: "保险受益人改成了苏婉", anchorLine: "老爷死前一个月，把保险受益人改成了苏婉", phantomLine: "受益人早就换人了，你不知道" },
  { id: "F-09", estab: "P-02", knowers: ["苏婉", "陆见深"], anchor: "老爷的私章", anchorLine: "老爷的私章在我这，谁也别想动", phantomLine: "老爷那枚私章，你收好了" },
  { id: "F-10", estab: "P-02", knowers: ["苏婉", "陆见深"], anchor: "转过去五十万", anchorLine: "周医生那边，我转过去五十万", phantomLine: "周医生那边收过一笔钱" },

  { id: "F-11", estab: "P-03", knowers: ["苏婉"], anchor: "病历上写的是心衰，不是落水", anchorLine: "病历上写的是心衰，不是落水", phantomLine: "老爷走的时候，是心衰，不是淹的" },
  { id: "F-12", estab: "P-03", knowers: ["苏婉"], anchor: "编号 S 的合同已经烧了", anchorLine: "编号 S 的合同已经烧了，你听清楚", phantomLine: "编号 S 那份，早烧了" },
  { id: "F-13", estab: "P-03", knowers: ["苏婉"], anchor: "海外那份信托", anchorLine: "海外那份信托，受益人不会写他女儿", phantomLine: "海外那笔钱，受益人不会写他女儿" },
  { id: "F-14", estab: "P-03", knowers: ["苏婉"], anchor: "上次换药的事", anchorLine: "上次换药的事，周医生嘴很紧", phantomLine: "换药的事，周医生嘴很紧" },

  { id: "F-15", estab: "P-04", knowers: ["沈知微", "助理"], anchor: "护照被人动过，出境记录有两笔", anchorLine: "你的护照被人动过，出境记录有两笔", phantomLine: "她那本证件，翻过一遍就知道了" },
  { id: "F-16", estab: "P-04", knowers: ["沈知微", "助理"], anchor: "外面还有一个女儿，今年七岁", anchorLine: "苏婉在外面还有一个女儿，今年七岁", phantomLine: "苏小姐在外面还有个孩子" },
  { id: "F-17", estab: "P-04", knowers: ["沈知微", "助理"], anchor: "公司账上少了一千二百万", anchorLine: "公司账上少了一千二百万，走的是供应商", phantomLine: "账上少的那笔，走供应商了吧" },
  { id: "F-18", estab: "P-04", knowers: ["沈知微", "助理"], anchor: "陈叔上个月递过辞呈", anchorLine: "陈叔上个月递过辞呈，被驳回来了", phantomLine: "陈叔上个月提过要走" },

  { id: "F-19", estab: "P-05", knowers: ["陆见深", "律师"], anchor: "血型是 AB 型", anchorLine: "老爷的血型是 AB 型，病历上却写着 O", phantomLine: "血型对不上，病历上写着 O" },
  { id: "F-20", estab: "P-05", knowers: ["陆见深", "律师"], anchor: "一份补充协议", anchorLine: "我手里有一份补充协议，没公开过", phantomLine: "还有一份补充协议，没公开" },
  { id: "F-21", estab: "P-05", knowers: ["陆见深", "律师"], anchor: "遗嘱不算数", anchorLine: "他临终前说遗嘱不算数，这话我听见了", phantomLine: "他最后那句话，等于把遗嘱作废了" },

  { id: "F-22", estab: "P-06", knowers: ["律师"], anchor: "第三排柜子后面有暗格", anchorLine: "第三排柜子后面有暗格，别让人看出来", phantomLine: "第三排柜子后头有个夹层" },
  { id: "F-23", estab: "P-06", knowers: ["律师"], anchor: "编号 S 的副本", anchorLine: "编号 S 的副本我藏在自己车里", phantomLine: "合同副本，藏在车里" },
  { id: "F-24", estab: "P-06", knowers: ["律师"], anchor: "补充协议上有苏婉的签字", anchorLine: "补充协议上有苏婉的签字，她赖不掉", phantomLine: "补充协议上写的是我的名字" },

  { id: "F-25", estab: "P-07", knowers: ["陈叔", "董事"], anchor: "去年那笔钱是我挪的", anchorLine: "去年那笔钱是我挪的，你知道就好", phantomLine: "去年那笔钱，是你挪的" },
  { id: "F-26", estab: "P-07", knowers: ["陈叔", "董事"], anchor: "老爷死前见过你一次", anchorLine: "老爷死前见过你一次，你最好记得", phantomLine: "老爷走前跟你说过话" },
  { id: "F-27", estab: "P-07", knowers: ["陈叔", "董事"], anchor: "老爷一段录音", anchorLine: "我手里有老爷一段录音，够用了", phantomLine: "我手里有段录音" },

  { id: "F-28", estab: "P-08", knowers: ["沈知微", "陆见深"], anchor: "诊所地址", anchorLine: "周医生的诊所地址查到了，在城西", phantomLine: "城西那家诊所，你们去过没有" },
  { id: "F-29", estab: "P-08", knowers: ["沈知微", "陆见深"], anchor: "陈叔的车，那天下午去过医院", anchorLine: "陈叔的车，那天下午去过医院", phantomLine: "那辆车那天下午去过医院" },

  { id: "F-30", estab: "P-09", knowers: ["陈叔", "助理"], anchor: "我是董事安排进来的", anchorLine: "我是董事安排进来的，你别声张", phantomLine: "厨房那个人，来路不正" },
];

/* ── 场景 ─────────────────────────────────────────────────────────────── */
const ESTAB_SCENES = {
  "P-01": { loc: "书房", cast: ["沈知微", "陈叔"], time: "现在" },
  "P-02": { loc: "客厅", cast: ["苏婉", "陆见深"], time: "现在" },
  "P-03": { loc: "苏婉房间", cast: ["苏婉"], time: "深夜" },
  "P-04": { loc: "卧室", cast: ["沈知微", "助理"], time: "现在" },
  "P-05": { loc: "医院走廊", cast: ["陆见深", "律师"], time: "现在" },
  "P-06": { loc: "档案室", cast: ["律师"], time: "现在" },
  "P-07": { loc: "花园", cast: ["陈叔", "董事"], time: "现在" },
  "P-08": { loc: "车里", cast: ["沈知微", "陆见深"], time: "现在" },
  "P-09": { loc: "厨房", cast: ["陈叔", "助理"], time: "现在" },
};
// 泄漏场次（按顺序挑：第一个能用的场次放 phantom，第二个放 anchored）
const LEAK_SCENES = [
  { id: "P-10", loc: "宴会厅", cast: ["苏婉", "董事", "律师"] },
  { id: "P-11", loc: "董事会", cast: ["董事", "律师", "助理"] },
  { id: "P-12", loc: "走廊", cast: ["陈叔", "苏婉"] },
  { id: "P-13", loc: "车里", cast: ["陆见深", "助理"] },
  { id: "P-14", loc: "医院走廊", cast: ["沈知微", "律师", "陈叔"] },
  { id: "P-15", loc: "卧室", cast: ["助理", "沈知微"] },
  { id: "P-16", loc: "书房", cast: ["董事", "苏婉", "陆见深"] },
  { id: "P-17", loc: "花园", cast: ["律师", "陈叔", "苏婉"] },
];

/* ── 分配：每条事实两条泄漏，选两个「泄漏者既不在知情者里、又在场」的场次 ── */
const leakLines = LEAK_SCENES.map((s) => ({ ...s, lines: [] }));
const leaks = [];
function pick(candidates) {
  // 优先挑当前行数最少的场次，避免某个场次堆 20 句
  return candidates.slice().sort((a, b) => a.s.lines.length - b.s.lines.length || a.s.id.localeCompare(b.s.id))[0];
}
for (const f of FACTS) {
  for (const variant of ["phantom", "anchored"]) {
    const usable = leakLines
      .map((s) => ({ s, leaker: s.cast.find((c) => !f.knowers.includes(c)) }))
      .filter((x) => x.leaker);
    if (usable.length < 2) throw new Error(`${f.id}: 可用泄漏场次不足`);
    const slot = pick(usable);
    const line = variant === "phantom" ? f.phantomLine : f.anchorLine;
    slot.s.lines.push(`${slot.leaker}：${line}。`);
    leaks.push({
      id: `${f.id}-${variant[0].toUpperCase()}`,
      kind: "no_source",
      variant,
      character: slot.leaker,
      scene: slot.s.id,
      surface: variant === "phantom" ? f.phantomLine : f.anchor,
      line,
      why:
        variant === "phantom"
          ? `换说法：「${f.phantomLine}」讲的仍是 ${f.estab} 那条事实（${f.anchor}），但不复述原话，当前归并不会把它挂回原命题。`
          : `沿用原话：「${f.anchor}」= ${f.estab} 的原话，对照组，归并应挂回原命题。`,
      established: f.estab,
      exact_scene: true,
      split: "dev",
    });
  }
}

/* ── 合法知道（must_not_flag）：知情者在后场用原话提起，必须放过 ── */
const LEGAL = FACTS.filter((_, i) => i % 5 === 0).map((f) => {
  const scene = leakLines.find((s) => f.knowers.some((k) => s.cast.includes(k)));
  const who = f.knowers.find((k) => scene.cast.includes(k));
  scene.lines.push(`${who}：${f.anchorLine}。`);
  return { character: who, scene: scene.id, surface: f.anchor, why: `${who} 在 ${f.estab} 就在场，是被告知/经手的人，合法` };
});

/* ── 断言：说法唯一、包含于唯一一行、泄漏者不在知情者里 ── */
const allLines = [...Object.entries(ESTAB_SCENES).flatMap(([id, s]) => s.cast.map((c) => ({ scene: id, who: c, text: `${c}：` }))), ...leakLines.flatMap((s) => s.lines.map((t) => ({ scene: s.id, who: t.split("：")[0], text: t })))];
for (const l of leaks) {
  const hit = leakLines.find((s) => s.id === l.scene).lines.filter((t) => t.includes(l.surface));
  if (hit.length !== 1) throw new Error(`${l.id}: 说法「${l.surface}」在 ${l.scene} 命中 ${hit.length} 行`);
  const f = FACTS.find((x) => x.id === l.id.slice(0, 4));
  if (f.knowers.includes(l.character)) throw new Error(`${l.id}: 泄漏者 ${l.character} 其实是知情者`);
}

/* ── 写剧本 ───────────────────────────────────────────────────────────── */
const head = `# 《幻影》—— 幻影命题专项集（测量仪器 · v2）

> **这份剧本只有一个目的**：把「泄漏台词换了说法 ⇒ 抽取层为它新建一条命题 ⇒ 首映场景在场者当场获得许可 ⇒ 泄漏自己把自己掩盖」这条机制**隔离出来量**。
>
> 每个事实都有**两条**泄漏，只有说法不同：
>   - \`phantom\`：换说法（不复述确立场景的原话 —— 这是要修的那一类）
>   - \`anchored\`：沿用确立场景的原话（对照组 —— 归并应把它挂回原来的命题）
>
> 读数**按变体分开报**，不汇总成一个 P/R。v1 只有 8 个事实（phantom 1/8），分辨率不足；v2 扩到 **30 个事实 / 30+30 条**。
> 本文件由 \`eval/build-phantom.mjs\` 生成（单表 → 剧本 + 标注），别手改。
>
> 角色：**沈知微**（女主）· **陈叔**（管家）· **苏婉**（反派）· **陆见深**（男主）· **律师** · **董事** · **助理**

---
`;
const estab = Object.entries(ESTAB_SCENES).map(([id, s]) => {
  const lines = FACTS.filter((f) => f.estab === id).map((f) => `**${id}.${f.id}** ${f.anchorLine}。`);
  return `## ${id}\n- 时间锚：${s.time} · 地点：${s.loc} · 在场：${s.cast.join("、")}\n\n${lines.join("\n")}\n\n---\n`;
}).join("\n");
const leakBlocks = leakLines.map((s) => `## ${s.id}\n- 时间锚：三天后 · 地点：${s.loc} · 在场：${s.cast.join("、")}\n\n${s.lines.join("\n")}\n\n---\n`).join("\n");
writeFileSync("eval/script-phantom.md", head + "\n" + estab + "\n" + leakBlocks, "utf8");

/* ── 写标注 ───────────────────────────────────────────────────────────── */
const out = {
  meta: {
    name: "《幻影》幻影命题专项集 v2",
    script: "eval/script-phantom.md",
    purpose:
      "量「换了说法就抓不到」这一层：每个事实两条泄漏，phantom 换说法（当前抓不到），anchored 沿用原话（对照）。读数按变体分开报。",
    revision: "v2：8 → 30 个事实（30 phantom + 30 anchored），另 6 条 must_not_flag 保护合法知道；由 build-phantom.mjs 生成。",
    note: "variant 是本集独有的字段。这不是选版本的决策集（不可用于裁决能力），它是机制探针 —— 价值在两种变体的差。",
    size: leaks.length,
  },
  leaks: leaks.map(({ line, ...rest }) => rest),
  must_not_flag: LEGAL,
};
writeFileSync("eval/leaks-phantom.json", JSON.stringify(out, null, 2) + "\n", "utf8");

const tally = (v) => leaks.filter((l) => l.variant === v).length;
console.log(`facts ${FACTS.length} · phantom ${tally("phantom")} · anchored ${tally("anchored")} · must_not_flag ${LEGAL.length}`);
console.log(leakLines.map((s) => `${s.id}=${s.lines.length}`).join(" "));

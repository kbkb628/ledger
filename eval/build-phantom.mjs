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

  { id: "F-31", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "保险柜第二格的钥匙", anchorLine: "保险柜第二格的钥匙在我这", phantomLine: "那道柜子的钥匙，你收着吧" },
  { id: "F-32", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "三年前的就诊记录被抽走了一页", anchorLine: "三年前的就诊记录被抽走了一页", phantomLine: "那本病历少了一张纸" },
  { id: "F-33", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "苏婉签过放弃继承的声明", anchorLine: "苏婉签过放弃继承的声明", phantomLine: "她当年签过一张不要家产的字" },
  { id: "F-34", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "沈父的私人账户在开曼", anchorLine: "沈父的私人账户在开曼", phantomLine: "钱存在海外一个小岛上" },
  { id: "F-35", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "律师收过苏婉两次钱", anchorLine: "律师收过苏婉两次钱", phantomLine: "那两笔好处费，都进了他口袋" },
  { id: "F-36", estab: "P-10", knowers: ["沈知微", "律师"], anchor: "老宅的地契压在律师楼", anchorLine: "老宅的地契压在律师楼", phantomLine: "房契一直搁在他事务所" },

  { id: "F-37", estab: "P-11", knowers: ["陆见深", "助理"], anchor: "助理那晚看见了车牌", anchorLine: "助理那晚看见了车牌", phantomLine: "那天晚上她记住了车号" },
  { id: "F-38", estab: "P-11", knowers: ["陆见深", "助理"], anchor: "陆见深的车换过一副牌照", anchorLine: "陆见深的车换过一副牌照", phantomLine: "那车挂过两块不同的牌子" },
  { id: "F-39", estab: "P-11", knowers: ["陆见深", "助理"], anchor: "后备箱里有个牛皮纸袋", anchorLine: "后备箱里有个牛皮纸袋", phantomLine: "后边那个袋子里装了东西" },
  { id: "F-40", estab: "P-11", knowers: ["陆见深", "助理"], anchor: "助理被苏婉威胁过", anchorLine: "助理被苏婉威胁过", phantomLine: "苏婉放话要收拾她" },
  { id: "F-41", estab: "P-11", knowers: ["陆见深", "助理"], anchor: "那晚下着雨，地上有脚印", anchorLine: "那晚下着雨，地上有脚印", phantomLine: "雨地里留下一串鞋印" },

  { id: "F-42", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "老爷的手抖是中毒", anchorLine: "老爷的手抖是中毒", phantomLine: "老爷一直抖，是被人下了药" },
  { id: "F-43", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "验血单被人换过", anchorLine: "验血单被人换过", phantomLine: "那张化验单不是原件" },
  { id: "F-44", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "护士记得那晚来过一个女人", anchorLine: "护士记得那晚来过一个女人", phantomLine: "值班的人说半夜来过女的" },
  { id: "F-45", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "老爷最后写过一个名字", anchorLine: "老爷最后写过一个名字", phantomLine: "他临了在纸上写了三个字" },
  { id: "F-46", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "病房的监控坏了三天", anchorLine: "病房的监控坏了三天", phantomLine: "那层楼的摄像头停了三天" },
  { id: "F-47", estab: "P-12", knowers: ["沈知微", "陈叔"], anchor: "陈叔替老爷垫付过药费", anchorLine: "陈叔替老爷垫付过药费", phantomLine: "药钱是老陈先付的" },

  { id: "F-48", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "董事在国外有个账户", anchorLine: "董事在国外有个账户", phantomLine: "他在外面开过户头" },
  { id: "F-49", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "苏婉的孩子不是陆见深的", anchorLine: "苏婉的孩子不是陆见深的", phantomLine: "那孩子跟陆家没关系" },
  { id: "F-50", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "律师替董事改过一份报表", anchorLine: "律师替董事改过一份报表", phantomLine: "那套账是他动手做的" },
  { id: "F-51", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "酒会请柬是伪造的", anchorLine: "酒会请柬是伪造的", phantomLine: "那张邀请函是假的" },
  { id: "F-52", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "苏婉给董事开过一张远期票", anchorLine: "苏婉给董事开过一张远期票", phantomLine: "她给过他一张迟到兑现的条子" },
  { id: "F-53", estab: "P-13", knowers: ["苏婉", "董事", "律师"], anchor: "董事知道录音的下半段", anchorLine: "董事知道录音的下半段", phantomLine: "后头那段他也听过" },

  { id: "F-54", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "井壁上有三道划痕", anchorLine: "井壁上有三道划痕", phantomLine: "井里的石头被划了三下" },
  { id: "F-55", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "后院埋过一只木箱", anchorLine: "后院埋过一只木箱", phantomLine: "院角底下压着个木头匣子" },
  { id: "F-56", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "老宅的佣人换过三批", anchorLine: "老宅的佣人换过三批", phantomLine: "宅子里的帮工换了三茬" },
  { id: "F-57", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "后门那把锁早坏了", anchorLine: "后门那把锁早坏了", phantomLine: "侧门的锁一直是松的" },
  { id: "F-58", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "沈父每晚在院里坐到半夜", anchorLine: "沈父每晚在院里坐到半夜", phantomLine: "老爷每天夜里都在院子里坐到很晚" },
  { id: "F-59", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "院墙东头被人挖开过", anchorLine: "院墙东头被人挖开过", phantomLine: "东边的墙根动过土" },
  { id: "F-60", estab: "P-14", knowers: ["陈叔", "沈知微"], anchor: "陈叔在院里烧过东西", anchorLine: "陈叔在院里烧过东西", phantomLine: "院里那堆灰是他点的" },
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
  "P-10": { loc: "档案室深处", cast: ["沈知微", "律师"], time: "现在" },
  "P-11": { loc: "车库", cast: ["陆见深", "助理"], time: "深夜" },
  "P-12": { loc: "医院病房", cast: ["沈知微", "陈叔"], time: "现在" },
  "P-13": { loc: "酒会", cast: ["苏婉", "董事", "律师"], time: "次日" },
  "P-14": { loc: "老宅后院", cast: ["陈叔", "沈知微"], time: "现在" },
};
// 泄漏场次（按顺序挑：先把「泄漏者既不在知情者里、又在场」的场次填满最少的那个）
const LEAK_SCENES = [
  { id: "L-01", loc: "宴会厅", cast: ["苏婉", "董事", "律师"] },
  { id: "L-02", loc: "董事会", cast: ["董事", "律师", "助理"] },
  { id: "L-03", loc: "走廊", cast: ["陈叔", "苏婉"] },
  { id: "L-04", loc: "车里", cast: ["陆见深", "助理"] },
  { id: "L-05", loc: "医院走廊", cast: ["沈知微", "律师", "陈叔"] },
  { id: "L-06", loc: "卧室", cast: ["助理", "沈知微"] },
  { id: "L-07", loc: "书房", cast: ["董事", "苏婉", "陆见深"] },
  { id: "L-08", loc: "花园", cast: ["律师", "陈叔", "苏婉"] },
  { id: "L-09", loc: "厨房", cast: ["陈叔", "助理", "陆见深"] },
  { id: "L-10", loc: "档案室", cast: ["律师", "董事", "沈知微"] },
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
const usedScene = new Map(); // factId → 已被登记为泄漏的场次集合
for (const l of leaks) {
  const f = l.id.slice(0, 4);
  if (!usedScene.has(f)) usedScene.set(f, new Set());
  usedScene.get(f).add(l.scene);
}
const LEGAL = FACTS.filter((_, i) => i % 5 === 0).map((f) => {
  const taken = usedScene.get(f.id) ?? new Set();
  const scene = leakLines.find(
    (s) => !taken.has(s.id) && f.knowers.some((k) => s.cast.includes(k)) && !s.lines.some((t) => t.includes(f.anchor)),
  );
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
const head = `# 《幻影》—— 幻影命题专项集（测量仪器 · v3）

> **这份剧本只有一个目的**：把「泄漏台词换了说法 ⇒ 抽取层为它新建一条命题 ⇒ 首映场景在场者当场获得许可 ⇒ 泄漏自己把自己掩盖」这条机制**隔离出来量**。
>
> 每个事实都有**两条**泄漏，只有说法不同：
>   - \`phantom\`：换说法（不复述确立场景的原话 —— 这是要修的那一类）
>   - \`anchored\`：沿用确立场景的原话（对照组 —— 归并应把它挂回原来的命题）
>
> 读数**按变体分开报**，不汇总成一个 P/R。v1 只有 8 个事实（phantom 1/8）、v2 扩到 30 对仍判不出显著性（McNemar 不一致对 5）；v3 再翻一倍到 **60 个事实 / 60+60 条**。
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
    name: "《幻影》幻影命题专项集 v3",
    script: "eval/script-phantom.md",
    purpose:
      "量「换了说法就抓不到」这一层：每个事实两条泄漏，phantom 换说法（当前抓不到），anchored 沿用原话（对照）。读数按变体分开报。",
    revision: "v3：30 → 60 个事实（60 phantom + 60 anchored），另 12 条 must_not_flag 保护合法知道；由 build-phantom.mjs 生成。",
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

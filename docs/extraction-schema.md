# 抽取 Schema 与事件类型词表

> 《账本》子设计文档 · 对应 `docs/design.md` 第 5、6 节
> 版本：0.2

---

## 0. 为什么这份文档决定产品成败

前面反复论证过一个结论：

> **归并的难度，取决于抽取的粒度。**
> 抽取只出自由文本短语 → 归并是难的语义问题（embedding 必漏）；
> 抽取出结构化事件 → 归并大部分退化成确定性问题。

所以**抽取 schema 是整个产品的杠杆点**，而不是实现细节。词表设计错了，后面用多强的 judge 都补不回来。

---

## 1. 设计原则

### 1.1 能力问题驱动（ontology 方法论）

**先列「必须能回答什么问题」，再反推需要哪些字段。**

| # | 能力问题 | 支撑它的字段 |
|---|---|---|
| Q1 | 某角色在第 N 场知道 / 相信什么？ | `knowledge_deltas` |
| Q2 | 某条命题第一次被交代来源是什么时候、通过什么方式？ | `knowledge_deltas.via` + `time_anchor` |
| Q3 | 哪条命题从未被交代来源？ | Q2 的反面（查空） |
| Q4 | 哪些命题被埋下但从未被使用？ | `setups` + `usages` |
| Q5 | 某条命题在某场被使用时，使用者当时的心智状态？ | `usages` + `knowledge_deltas` |

**每个字段都必须能追溯到某条能力问题。追溯不到的字段一律不加。**

### 1.2 克制（Cyc 的教训）

ontology 工程最著名的失败是 **Cyc**——投入数十年构建巨型本体，最后难以维护。

**只建够回答那 5 个问题的最小部分。** 词表宁少勿多：类型少了会把不同事件混在一起，但类型多了会导致**抽取不稳定**（同一事件在不同场景被抽成不同类型），后者更难修。

### 1.3 归并友好

字段设计的第一目标是**让同一事件的不同措辞落到同一组字段值上**，使归并能用结构匹配而非语义相似。

### 1.4 证据必须内建

每条抽取结果都必须带 `evidence_span`（原文片段）。这是产品「可举证、可反驳」的地基——**证据不能由 judge 事后生成，必须在抽取时捕获**。

---

## 2. 抽取单元与产物

**单元 = 一场戏（scene）。** 因为时间锚定、角色出场、场内信息流都是场级的；短剧单场通常 1–3 分钟，粒度合适。

一场戏产出一份结构化记录：

```
scene
├─ 场景元信息（时间锚、出场角色、地点）
├─ events[]            发生了什么（含极性、情态、确定性）
├─ knowledge_deltas[]  谁的心智因此变了
├─ usages[]            谁用到了什么（待绑定）
└─ setups[]            埋下了什么（伏笔）
```

---

## 3. 字段定义

### 3.0 字段优先级：索引 vs 证据（**由 P1-2 消融实测确立**）

> 实测（JEV，48 样本）：**去掉全部结构化字段（type/agent/patient/object/time_ref），
> 判定准确率不降反升**（91.7% → 93.8%，1 条样本，噪声内）。见 `test-plan.md` P1-2。

原因是这些字段都是 canonical 散文的**派生冗余**——「苏婉伪造了遗嘱」已含类型、施事、客体。

因此字段分两类，**实现次序不同**：

| 类别 | 字段 | 作用 | 优先级 |
|---|---|---|---|
| **证据** | `canonical`（命题表述）、`surface`（指称短语 → 别名来源） | 直接喂给判定器，决定准确率 | **P0，没有它判定链路不通** |
| **索引** | `type` / `agent` / `patient` / `object` / `time_ref` | 不喂判定器；用于**候选召回、事件同一性、影响传播** | P1，做不出可先留空 |

> **一句话**：证据字段决定「判得对不对」，索引字段决定「找得到找不到、算得出算不出代价」。
> 打通端到端链路只需要前者。

### 3.1 场景级

```jsonc
{
  "scene_id": "S03-07",
  "episode": 3,
  "scene_no": 7,
  "time_anchor": {
    "kind": "present",            // present | flashback | flashforward | dream | imagined
    "relation": "same_as_main",   // same_as_main | before_main | after_main | unknown
    "offset_hint": "-3y",         // 原文里的相对表述，可为 null
    "confidence": 0.9,
    "evidence": "三年前"
  },
  "present_characters": ["女主", "反派"],   // 必须绑定到已知角色
  "location": "仓库"
}
```

**为什么 `time_anchor` 是必需的**：短剧是闪回 / 重生 / 穿越最密集的剧种，「叙事顺序 ≠ 剧情时间」。不显式表达，账本整个是错的。

> ⚠️ `offset_hint` 允许为 null 且**不要求精确**。它的作用不是算出绝对时间，而是判断「这两场戏是否在同一时间层」。

**`present_characters` 决定谁能获知**——它是 R1 的关键输入，不是装饰。

### 3.2 事件级

```jsonc
{
  "local_id": "e1",                    // 场内唯一，用于 knowledge_deltas / usages 引用
  "type": "fire",                      // 受控词表，见第 4 节
  "surface": "老爷留下的那份东西",      // 本场对该事件的**指称短语**（≠ evidence_span，用于日后作别名，见 5.5）
  "other_label": null,                 // 仅 type=other 时填（自由文本）
  "agent": "反派",                     // 施事（可为未出场角色）
  "patient": "仓库",                   // 受事（人或物）
  "object": null,                      // 涉及的道具/凭证（怀表、合同、照片）
  "location": "仓库",
  "time_ref": {
    "raw": "三年前",
    "kind": "relative",                // absolute | relative | event_anchored | vague
    "normalized": "-3y"
  },
  "polarity": "affirmed",              // affirmed | negated | questioned
  "modality": "asserted",              // asserted | intended | planned | desired | doubted | hypothesized
  "certainty": "certain",              // certain | probable | rumored
  "witnesses": ["女主"],
  "evidence_span": "你三年前烧了那间仓库",
  "confidence": 0.9
}
```

#### 三个最容易被忽略、但决定正确性的字段

**① `polarity`（极性）**

「反派烧了仓库」/「反派**没**烧仓库」/「是反派烧的吗？」是**三条不同的命题**。不区分，账本会把它们当成同一条。

**② `modality`（情态）**

| 台词 | 正确抽法 | 错误抽法 |
|---|---|---|
| 「我要杀了你」 | `type=kill, modality=intended` | 抽成"他杀了人" → **R1 立刻误报** |
| 「他应该早就跑了」 | `modality=hypothesized` | 抽成断言 |
| 「我发誓要让她后悔」 | `modality=intended` | 抽成已发生 |

**短剧里狠话、威胁、计划极其密集**——把意图抽成事实是最高频的抽取错误。

**③ `certainty`（叙事内的确定性）**

`rumored`（传闻）是叙事内的重要信息：角色听到的**可能是假的**。它和误信追踪直接相关。

> 注意区分：`certainty` 是**故事内的**确定性，`confidence` 是**抽取器自己的**置信度。两者不是一回事。

#### `object` 与 `patient` 为什么要分开

- `patient`：受事（被烧的**仓库**）
- `object`：作为证据/信物流转的道具（**怀表**、**合同**、**照片**）

道具往往是伏笔的载体（→ R3），且经常是跨场指代的锚点，混进 patient 会丢失这条线索。

### 3.3 知识变化级

```jsonc
{
  "character": "女主",
  "target": { "event_local_id": "e1" },   // 或 proposition_ref（跨场时）
  "transition": "learns",                 // learns | believes | disbelieves | suspects | forgets
  "via": "overheard",                     // told | overheard | witnessed | inferred | evidence | told_lie
  "source_agent": "反派",
  "evidence_span": "她在门外听见了那件事",
  "confidence": 0.85
}
```

**`transition` 区分 `learns` 与 `believes` 是认知层落地的关键**：

- `learns`：通过可靠渠道获得（亲眼所见、权威告知）→ 进 **knowledge**
- `believes`：通过不可靠渠道获得（**被欺骗**、传闻、误读证据）→ 进 **belief**
- `suspects`：怀疑（未确信）→ 单独一档，**不参与 R1 判定**（她怀疑不等于她知道）

**`via=told_lie`** 是「被欺骗而相信」的显式标记——它让误信追踪成为可能。

### 3.4 使用级

```jsonc
{
  "character": "女主",
  "mention": {
    "surface": "那件事",
    "mention_kind": "vague_pronoun",     // explicit_noun | repeated_surface | vague_pronoun
    "resolved_hint": "反派烧了仓库",      // 抽取器还原出的规范描述（可为 null）
    "resolved_from": null                // 还原依据的原文（可为 null）
  },
  "target": { "event_local_id": null },  // 场内可解析时直接绑定
  "evidence_span": "你三年前烧了那间仓库",
  "confidence": 0.8
}
```

**`usage` 的可操作定义**（这是 R1 的判据，必须定义清楚）：

> 角色 C 在一场戏中**说出或依据**命题 P，且 P **不是在该场戏中首次被传达给 C**。

第二种情形（"首次被传达给他"）是 `knowledge_delta` 而不是 `usage`。A 告诉 B 一件事时，**A 是 usage，B 是 knowledge_delta**。

**`mention_kind` 是动态阈值的输入**：`vague_pronoun` 的接受阈值更高。

**`resolved_hint` 是归并的主线索**：抽取器借上下文把「那件事」还原成规范描述，归并时比的是 `resolved_hint` 而非 surface。

### 3.5 伏笔级（R3）

```jsonc
{
  "local_id": "s1",
  "kind": "object_introduced",   // object_introduced | info_hinted | ability_shown | relationship_implied
  "subject": "怀表",
  "significance": "high",        // high | medium | low
  "evidence_span": "她摩挲着那块怀表"
}
```

`significance` 用于**降噪**——只报 high/medium，避免把每个出现的道具都算成伏笔（否则 R3 会被噪声淹没）。

---

## 4. 事件类型词表

**22 个类型，10 组，加 1 个兜底。**

设计目标：**让同一事件的不同措辞落到同一个 type**，使归并能结构匹配。

| 组 | type | 定义 | 正例 | 易混 |
|---|---|---|---|---|
| **伤害与冲突** | `harm` | 造成身心伤害（含未遂、受伤、威胁、虐待） | 打伤、推下楼、**我要让你付出代价** | 与 `kill` 的区别是**未致死** |
| | `kill` | 造成死亡 | 杀了他、害死 | `death` 是**状态**，`kill` 是**动作** |
| **事故** | `accident` | 意外事故 | 车祸、坠落、溺水 | 与非意外要分开：`fire` 可能是纵火 |
| | `fire` | 火灾 / 纵火 | 烧了仓库、起火 | 核心例子所用的类型 |
| **欺骗与隐藏** | `deception` | 使人相信虚假信息（含陷害、栽赃） | 骗她、栽赃、伪造证据 | 与 `conceal` 的区别：**主动造假** vs **不说不报** |
| | `conceal` | 隐瞒、不披露 | 瞒着她、没告诉他 | 隐瞒本身可能是合理的（不算错） |
| | `impersonate` | 冒充他人身份 | 假冒千金、顶替 | 与 `identity_change` 的区别：**冒充别人** vs **自己身份变了** |
| **关系** | `betray` | 背叛、出卖 | 出卖了他、背后捅刀 | 与 `deception` 区别：**信任关系内的** |
| | `promise` | 承诺、发誓 | 我答应你、发誓 | `modality` 通常为 `asserted`（承诺是已发生的行为） |
| | `deal` | 交易、契约 | 签约、协议、买卖 | |
| | `rescue` | 救助 | 救下她、挡了一刀 | |
| **婚姻家庭** | `marry` | 结婚 / 订婚 | 婚礼、领证 | |
| | `divorce` | 离婚 / 分手 | 离婚、解除婚约 | |
| **秘密与身份** | `identity_secret` | 身世 / 血缘秘密 | 私生子、抱错、亲生父亲 | |
| | `identity_change` | 自身身份变化 | 重生、穿越、换脸、失忆后换了身份 | 短剧特有，高频 |
| | `recognize` | 认出 / 相认 | 认出她、父子相认 | |
| **财物** | `transfer` | 财物 / 权利转移 | 赠予、夺走、继承、遗产 | |
| **身体状态** | `illness` | 疾病（含失忆、精神问题） | 绝症、失忆、疯了 | 状态类，非动作 |
| | `death` | 死亡（状态） | 他死了、去世 | 与 `kill` 的区别见上 |
| **信息** | `reveal` | 揭露（说出他人秘密 / 真相） | 揭穿、说破 | 与 `confess` 区别：**揭别人** vs **认自己** |
| | `confess` | 承认（承认自己做过的事） | 我承认、坦白 | |
| **兜底** | `other` | 无法归入上述任何一类 | 相遇、结盟、日常 | **必须填 `other_label`** |

### 4.1 兜底类型的特殊规则

> **`type = other` 的条目一律不参与自动归并，必须走 judge 层。**

因为 `other` 没有区分度——两个不同的 `other` 事件在结构上看起来一样。若允许它们按 `type` 匹配，会造成大量错误归并。

### 4.2 词表的维护规则

1. **加类型要比改定义谨慎。** 加类型会让历史数据的 `other` 与新类型不一致。
2. **改定义 = 版本升级。** 词表带版本号，随抽取结果一起落库（`extract_ver`）。旧数据可识别、可重抽。
3. **`other` 的占比是健康指标。** 如果 `other` 长期超过 15%，说明词表漏了高频类型，该补。

---

## 5. 与归并的接口

抽取的字段直接决定归并第 1 层（结构匹配）能否成立。

### 5.1 结构匹配的键

```
完全匹配（自动归并，零成本）：
  type 相等（且 ≠ other）
  且 agent 相等
  且 (patient 或 object) 有交集
  且 time_layer 一致（见 5.2）
  且 polarity 相等
```

### 5.2 为什么用 `time_layer` 而不是 `time_ref` 相等

`time_ref` 常常是模糊的（「很久以前」「那天」），要求相等会导致大量漏匹配。

**改为比较「时间层」**：把 `time_anchor.relation` + 事件级 `time_ref` 合成一个粗粒度层：

```
层 = { 主线现在, 主线之前, 主线之后, 未知 }
```

- 同层 + 其他字段全等 → 自动归并
- 跨层 → **不自动归并**（可能是两次不同的事件），进 judge

这样既避免漏配，又挡住了「三年前烧仓库」与「现在烧仓库」被错误合并。

### 5.3 部分匹配 → judge

字段有 1–2 项不一致时（例如 `patient` 相同但 `type` 不同：`fire` vs `accident`），进 JEV 层。

**判定请求里必须带上这些不一致点**——它们是 judge 的主要线索：

```jsonc
{
  "differing_fields": ["type"],
  "mention": { ... },
  "candidates": [ ... ]
}
```

### 5.4 不参与匹配的字段

`confidence`、`evidence_span`、`certainty` **不参与**结构匹配。前两个是元信息，`certainty` 是叙事内的属性（同一条命题可以被确定地知道，也可以只是传闻）。

---

### 5.5 命题必须携带「典型表述」（keywords）—— 实测最重要的一条

**这是 `rsi-log.md` 用对照实验得出的、唯一直接改变抽取层设计的结论。**

判定层（尤其是便宜模型）的准确率**高度依赖输入里是否含字面线索**：

| 候选呈现方式 | JEV 准确率 | 变化 |
|---|---|---|
| canonical 规范描述 | 47.9% | 基线 |
| **+ 结构化三元组**（relation） | 47.9% | **±0pp** |
| **+ 典型表述**（keywords） | **91.7%** | **+43.8pp** |

> **有效的不是「结构化」，而是「保留字面线索」。**
> 三元组**压缩**了字面信息 → 无效；关键词**补回**了字面信息 → +43.8pp。

而且**别名越多，效果越好**：

| 候选平均可用的典型表述数 | 准确率 |
|---|---|
| 1 条 | 87.5% |
| **2 条及以上** | **95.5%** |

#### 因此抽取层与账本层各有一项新要求

**抽取层**：每个事件除 `evidence_span`（原文出处）外，还要给出 **`surface`** ——
该事件在**这一场里被怎么称呼**的规范化短说法，用于日后成为别名。

**账本层**：命题维护 `aliases` 表，累积各场出现过的说法，并记录首次出现位置：

```jsonc
{
  "proposition_id": "F-009",
  "canonical": "陈默手上持有沈父遗嘱的原件",
  "aliases": [
    { "surface": "老爷留下的那份东西", "first_seen": "S04-02" },
    { "surface": "那份东西",           "first_seen": "S05-01" },
    { "surface": "那份原件",           "first_seen": "S14-01" }
  ]
}
```

**判定接口**：候选必须带上**该时点已经积累的**典型表述（即 `keywords`）。

> ⚠️ **`canonical` 必须排除在 `keywords` 之外**。它是抽取层的**规范描述**（长句），
> 不是剧中的说法；混进 keywords 会稀释真正的字面线索 —— 实测准确率因此下降
> **2.1pp**（91.7% → 89.6%）。`canonical` 由独立字段承载，与 keywords 并列而非混合。

> ⚠️ **必须做时序过滤**：处理位于场景 S 的样本时，只能用 `first_seen ≤ S` 的说法。
> 否则等于把命题**未来才会积累**的说法提前告诉模型 —— 这是实验效度的底线，
> 也是 `rsi-log.md` 记下的那次教训（见其「效度教训」节）。

---

## 6. 与审计规则的接口

| 规则 | 依赖字段 |
|---|---|
| **R1 知识泄漏** | `usages`（谁用了） + `knowledge_deltas`（谁何时学到/相信） + `time_anchor`（时序） |
| **R2 无源信息** | `usages` 减去 `knowledge_deltas`，**再减去默认知识层** |
| **R3 伏笔未回收** | `setups`（埋了什么） + 全部 `usages`/`events`（有没有被兑现） |

### R1 的判定需要三个约束同时成立

```
used_at(S, P, C)                          ← usages
且 P ∉ (knows(C) ∪ believes(C)) at S      ← knowledge_deltas（注意：suspects 不算）
且 S 不是 P 首次传达给 C 的场景             ← 排除"他被告诉"那一刻
```

第三条最容易被漏掉——**「A 告诉 B」的场景里，B 对这条命题是 knowledge_delta，不是 usage**。

---

## 7. 抽取指令模板（prompt 骨架）

```text
你是短剧剧本的结构化抽取器。输入是一场戏的原文，输出严格的 JSON。

【已知角色】{{ character_list }}
只能使用上面列出的角色名。出现新角色时，用 name 字段标记 new=true。

【已知命题候选】（可为空）
{{ candidate_propositions }}
若某句台词指向其中一条，请在 usages[].target 里引用它。

【硬性规则】
1. polarity —— 分辨「做了」「没做」「做了吗」。否定与疑问必须如实标注。
2. modality —— 「我要杀了你」是 intended，不是已发生。短剧里狠话与计划极多，
   把意图抽成事实是最高频的错误。
3. certainty —— 角色听来的传闻标 rumored，不要与亲眼所见混同。
4. witnesses —— 这一场在场且能看到/听到的角色，全部列出。它决定谁能获知。
5. resolved_hint —— 遇到「那件事」「那笔账」这类模糊指代，尽力从上下文还原出
   规范描述；还原不了就留 null，不要猜。
6. type 只能取受控词表里的值；无法归类用 other 并填 other_label。
7. evidence_span 必须是原文的连续片段，不要改写、不要拼接。
8. 不确定的字段宁可留 null 并降低 confidence，不要编造。

【输出 schema】
{{ schema }}

【原文】
{{ scene_text }}
```

### 7.1 模板里三条最关键的话

1. **「把意图抽成事实是最高频的错误」**——显式警告模型最常见的失败模式
2. **「还原不了就留 null，不要猜」**——模糊指代的 guessing 会污染别名表
3. **「evidence_span 必须是原文连续片段」**——防止模型改写证据，破坏可举证性

### 7.2 该注入什么、不该注入什么

| 注入 | 原因 |
|---|---|
| 已知角色清单 | 保证角色名规范化，否则归并永远匹配不上 |
| 已知命题候选（**少量**，按第 5 节检索） | 让场内指代可当场绑定 |
| 输出 schema | 结构化约束 |

**不要注入**：全剧本、全局设定集。那会把抽取退化成"理解全文"，且成本失控。

---

## 8. 未决问题

| 问题 | 状态 |
|---|---|
| 词表 22 个类型是否够用 | **待真实剧本验证**——跑一遍抽取，看 `other` 占比 |
| `time_layer` 的粗粒度是否够 | 待验证（闪回嵌套多层时可能不够） |
| 角色名规范化（别名、代称） | 抽取层做还是归并层做，未定 |
| 多命题台词（一句话含两件事） | 是否拆成多个 event，未定 |
| 群戏的 witnesses 边界 | 「在场但没注意」算不算，需定义 |
| 抽取失败的降级 | 场景抽取失败时整场丢弃还是重试，未定 |

### 一条验证建议

**先只跑抽取，不跑判定的其余部分**：用 10–20 场真实（或自造）短剧戏，人工检查三件事：

1. `other` 占比（目标 < 15%）
2. `polarity` / `modality` 的错误率（这是最高频错误）
3. `evidence_span` 是否忠实原文

**这三个指标不达标，不要在归并和审计上继续投入。** 抽取是地基。

---

## 9. 演进策略：哪些必须现在定，哪些交给测试

**原则：本 schema 不是定稿，是由开发与测试驱动的活文档。** 但「能灵活改」本身需要设计——否则落库之后事实上就定死了。

### 9.1 三类稳定性

| 类 | 内容 | 改动代价 |
|---|---|---|
| **骨架（必须现在抽）** | `polarity` · `modality` · `evidence_span` · `time_anchor` | **极高**——不抽则账本错，且错误会经别名表传播；事后补要全量重跑 |
| **参数（允许调）** | 事件类型的具体条目、阈值 | 中——**加类型比改定义安全**（见 4.2） |
| **细节（一定会变）** | 字段命名、可选字段、prompt 措辞 | 低 |

### 9.2 让「灵活改」成立的机制

> **抽取结果必须是「可丢弃、可重算」的，而不是不可变的事实。**

```jsonc
{
  "scene_id": "S03-07",
  "extract_ver": "0.3",          // 产出它的 schema + prompt + 词表版本
  "extracted_at": "2026-10-17T…",
  "result": { /* … */ }
}
```

配套三条：

1. **`extract_ver` 落库** —— 任何结果都能追溯到产出它的版本
2. **支持增量重抽** —— 改词表后只重抽 `extract_ver` 落后的场景
3. **抽取结果与账本分离** —— 重抽场景 → 只重算该场景的账本条目（命题 / 心智 / 使用），不动其他

> ⚠️ 与 Kumiho 式「Revision immutable」的区别：**账本的命题是可变的**（可归并、可失效），**抽取结果是可重算的**。唯一必须不可变的是 `evidence_span` —— 它指向原文，不能被重写。

### 9.3 用测试驱动 schema，而不是用推演

**不要一次实现 22 个类型 + 全部字段。** 先做「最小骨架版」：

| 层 | 骨架版先做 | 后加 |
|---|---|---|
| 场景 | `time_anchor`、`present_characters` | `location` |
| 事件 | `type`（**先 10 个高频类型**）、`agent`、`patient`、`polarity`、`modality`、`evidence_span`、`confidence` | `object`、`certainty`、`time_ref.normalized` |
| 知识 | `character`、`transition`、`via`、`evidence_span` | `source_agent` |
| 使用 | `character`、`surface`、`mention_kind`、`resolved_hint`、`evidence_span` | — |
| 伏笔 | **先不做**（R3 后置） | `setups` |

跑 20 场真实（或自造）戏，由**三个观测**决定下一步加什么：

| 观测 | 触发条件 | 动作 |
|---|---|---|
| `other` 占比 | > 15% | 对实际出现的 `other_label` 聚类，补高频类型 |
| `polarity` / `modality` 错误率 | 偏高 | 先改 prompt + 加反例；仍高则考虑拆分字段 |
| **字段空置率** | 某字段长期为 null | **删掉它** |

**最后一项容易被忽略，但它是防本体膨胀最有效的机制**——ontology 的失败（Cyc）正是从不删字段开始的。

---

## 修订记录

| 版本 | 内容 |
|---|---|
| v0.1 | 初稿：设计原则（能力问题驱动 / 克制 / 归并友好）、字段定义、22 个事件类型词表、与归并和审计规则的接口、抽取 prompt 骨架、演进策略 |
| **v0.2** | 依据 [`rsi-log.md`](rsi-log.md) 的对照实验（**keywords 带来 +43.8pp**）：新增 3.2 的 `surface` 字段、新增 5.5「命题必须携带典型表述」，明确账本层 `aliases`（含 `first_seen`）与判定接口的**时序过滤**要求 |

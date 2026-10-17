# 叙事一致性 / 矛盾自动检测：开源与研究现状（第 2 路调研）

> 说明：本报告仅收录我能用链接佐证的内容。GitHub 域在本会话被网络策略拦截（"non-public IP"），仓库存在性与代码可运行性由检索结果/论文自述佐证，**未逐个克隆验证**，已在下文标注。

## 汇总表

| 名称 | 年份 | 方法 | 检测的矛盾类型 | 覆盖知识状态 | 有代码 |
|---|---|---|---|---|---|
| [Visual Continuity Errors in Movies (Pickup & Zisserman)](https://www.robots.ox.ac.uk/~vgg/research/continuity/) | 2009 | 计算机视觉：镜头分割＋配准＋patch 差分 | 影视**视觉**连续性（道具移动、影子、杯子空满） | 否 | 未见公开仓库 |
| [Nece: Narrative Event Chain Extraction Toolkit](https://ar5iv.labs.arxiv.org/html/2208.08063) | 2022 | 事件抽取＋成对时序关系（含窗口=5） | 不判矛盾；产出事件链与时序 | 否（只给骨架） | 论文称提供工具包，未验证 |
| [FactTrack (NAACL 2025)](https://aclanthology.org/2025.naacl-long.144.pdf) | 2024-07 / NAACL 2025 | LLM 分解原子事实＋时间有效性区间（Allen 区间代数）＋微调 NLI 判矛盾 | 时序性事实矛盾、剧情冗余 | 否（世界事实，非角色信念） | [github.com/cogito233/fact-track](https://github.com/cogito233/fact-track) |
| [TimeChara (Findings of ACL 2024)](https://aclanthology.org/2024.findings-acl.197/) | 2024-05 | benchmark；点时间角色问答 | LLM 扮演角色时"说了该时点不该知道的事" | **是**（时间点×角色知识） | [github.com/ahnjaewoo/timechara](https://github.com/ahnjaewoo/timechara) |
| [FlawedFictions / FlawedFictionsMaker](https://arxiv.org/abs/2504.11900) | 2025-04 | 合成式 benchmark：抽取第一幕命题→反事实否定→人工过滤 | 连续性错误（continuity error）总类 | 部分（ToM 为所需能力之一，非显式知识状态结构） | [github.com/kabirahuja2431/FlawedFictions](https://github.com/kabirahuja2431/FlawedFictions) |
| [OpenToM (ACL 2024)](https://aclanthology.org/2024.acl-long.466/) | 2024-02 | benchmark，角色信念/心理状态推理 | 角色信念与真实世界不一致的推理题 | **是**（信念状态，但为问答评测） | 论文/项目页声称公开 |
| Projecting Characters' Knowledge from Utterances in Narratives | 2025（存疑） | 未确认（原文抓取失败） | 从台词推断角色所知 | **是**（最贴题） | **未确认** |
| Remember Me: 用知识图谱增强长程角色一致性（ICCC） | 未确认（ICCC26 预印本 PDF） | LLM＋知识图谱 | 生成中的角色长程不一致 | 部分 | 未确认 |
| Narrative Consistency in LLM-Generated Stories: A Survey（IEEE） | 未确认 | 综述 | 综述称现有度量"开箱即用都不适用于叙事一致性" | — | — |

## 逐条说明

**FlawedFictions（最直接对标"剧情漏洞自动检测"）**：把 plot hole 形式化为"用故事中其余命题＋读者常识可推出 ¬φ"，因此明确指出光靠两个句子做 NLI 不够。最佳模型 Claude 3.5 Sonnet 分类准确率 0.76、定位 CEEval-Full 0.67，**恰好等于人类 0.76 / 0.68**；GPT-4o 0.64/0.58，Llama-3.3-70B 0.57/0.38，纯 NLI 基线 0.53/0.04（几乎无用）。加长到 1200–4000 词的 FlawedFictionsLong 上，最好的 o1 只有 0.61/0.53，多数模型贴近"永远答没有错误"的基线（0.51）。作者还发现加大推理预算（o1/o3-mini 提高 reasoning effort）**不升反降**。

**FactTrack（唯一可复用的时序一致性引擎）**：把事件拆成 pre-facts/post-facts，用 [0,1] 区间维护每条原子事实的有效期，只在"两个检查点都重叠且矛盾"时报错，以压误报。LLaMA2-7B 版在 90 个故事大纲上的 GPT-4 打分 2.393/2.777，明显超过随机 1.419、暴力成对检测 1.452 和 GPT-3.5 全文检测 1.556，接近 GPT-4 全文 2.355/2.859。局限作者自己写明：**事件分解是瓶颈**，语言歧义会先毁掉下游；且只处理二元矛盾。

**TimeChara 与 OpenToM：真正碰"谁知道什么"的两条线**。TimeChara 直接造了"角色在某时间点只能知道某集合信息"的评测，属于角色知识状态这一类；OpenToM 测的是 ToM 式信念推理。但两者都是**问答/评测集**，不是可插进产品管线的审计器。

**Nece**：提供事件抽取与事件间时序关系，是"事件时序抽取"这一层的可用地基；它不做矛盾判定。

**视觉连续性**：Pickup & Zisserman 的 2009 工作把"电影连贯性错误"做成可计算的 spot-the-difference（先按镜头/thread 把 10 万帧降到 200–550 对候选，再用人物/运动检测排除"可解释差异"）。这是**视觉**连续性，与"角色知识泄漏"完全不同的层次，但"候选对剪枝再判定"的架构思路可借鉴。

**伏笔（setup-payoff）自动识别**：检索中出现 Codified Foreshadowing-Payoff Text Generation、AAAI AIIDE 的 predictive inference/foreshadowing 度量等条目，但我**未能读到原文**，覆盖面与效果**未确认**。就目前证据看，这一子问题是四类里最薄弱、最缺公开 benchmark 的。

## 结论

1. **学术上未解决。** 最接近的 FlawedFictions 显示：在 ≤4000 词的短篇上，前沿模型仅与人打平；长文上全部跌回随机附近，且提升推理预算无效。**"角色知识状态/信息流"更没被解决**：TimeChara/OpenToM 只把它做成静态问答 benchmark，没有任何一篇论文给出"输入完整剧本→输出角色×时间点×信息集合"的成熟图谱管线与指标。叙事一致性综述本身也承认现有度量不适用。
2. **工程上可复用的组件很少。** 真正能用的是三块零件：FactTrack 的"原子事实＋有效期区间＋Allen 区间判定"（有代码、有消融）、Nece 式事件链/时序抽取、以及 FlawedFictions 作为回归测试集。**没有**能直接调用的"知识泄漏检测器"或"伏笔回收检测器"；TimeChara 只能当评测，不能当引擎。
3. **面向短剧编剧产品的技术空白与最大坑。** 空白点：① 角色知识状态需要 3D 结构（角色 × 剧情时间 × 信息原子）并区分"亲眼所见／被告知／推断／观众知道但角色不知道"，公开工作里只有评测集没有构建器；② 伏笔的 setup-payoff 配对几乎无公开数据与指标；③ 无"无源信息"（信息从未交代来源）这一类的任何形式化定义。最大坑按危害排序：**(a) 事件时序抽取不可靠**——剧本大量使用闪回、插叙、并行剪辑，而 FactTrack 类方法默认叙事顺序＝时间顺序，一旦错序，全部矛盾判定会系统性跑偏；**(b) 实体消解**——"她／那个男人／三年前的他"以及化名、易容、同角色不同时期，会让知识归属直接错人；**(c) 误报成本**——FlawedFictions 的 NLI 基线定位分仅 0.04，说明朴素做法会淹没编剧；LLM 方案则强依赖模型代际（Claude 3.5 与人打平，同代其他模型接近随机），产品效果会被上游模型版本牵着走。可行的产品化路线应是"LLM 抽取＋结构化区间/图谱存储＋只在结构层判矛盾"，把 LLM 限制在抽取步，并用候选剪枝（学 VGG 那套）控制误报。

## 引用 URL

- https://arxiv.org/abs/2504.11900 （FlawedFictions，全文本地抓取自 ar5iv）
- https://github.com/kabirahuja2431/FlawedFictions
- https://aclanthology.org/2025.naacl-long.144.pdf （FactTrack，NAACL 2025）
- https://ar5iv.labs.arxiv.org/html/2407.16347 （FactTrack 全文）
- https://github.com/cogito233/fact-track
- https://aclanthology.org/2024.findings-acl.197/ （TimeChara）
- https://github.com/ahnjaewoo/timechara
- https://aclanthology.org/2024.acl-long.466/ （OpenToM）
- https://ar5iv.labs.arxiv.org/html/2208.08063 （Nece）
- https://www.robots.ox.ac.uk/~vgg/research/continuity/ （视觉连续性错误）
- https://par.nsf.gov/biblio/10615183 （Projecting Characters' Knowledge from Utterances in Narratives）
- https://computationalcreativity.net/iccc26/papers/ICCC26_paper_39.pdf （Remember Me / KG 角色一致性）
- https://ieeexplore.ieee.org/document/11595786/ （Narrative Consistency in LLM-Generated Stories: A Survey）
- https://aclanthology.org/2025.acl-long.1103/ （The Essence of Contextual Understanding in Theory of Mind）

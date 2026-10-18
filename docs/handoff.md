# 交接说明（handoff）

> 写给「下一个会话的自己」和任何接手的人。目标是：**不读对话历史也能继续做**。
> 最后更新：回合 30 之后。

## 1. 这是什么，现在到哪一步

《账本》—— AI 短剧的叙事一致性账本，形态是 MCP server。它回答一个问题：
**这个角色，在说这句话的时候，该知道这件事吗？**

| 交付项 | 状态 |
|---|---|
| Git 仓库（公开） | ✅ https://github.com/kbkb628/ledger |
| 线上链接 | ✅ https://kbkb628.github.io/ledger/ （GitHub Pages，源为 `/docs`） |
| 至少一条用户路径完整走通 | ✅ `npm run mcp:smoke` 八步全通：报错→建账 14s→重复建账被拒→拦截→放过→审计→豁免→读词条 |
| ≤5 分钟录屏 | ❌ 未做 |
| `npx -y` 可装 | ❌ 未做（`package.json` 的 `bin` 还指向 `tsx src/mcp/server.ts`，只能在本仓库里跑） |
| 真实客户端实测（DSH / Claude Code） | ❌ 未做（只有 SDK 冒烟；「挂到用户自己的 agent 上」还没在真客户端里验过） |

## 2. 当前基线（改任何东西之前先核对这些）

三个版本戳，任一不一致 → 两个数字不可比：

- `testset` = `leaks@1#cc59a5ad9de1`
- `scorer` = `r1@5c4757558d19`
- `contextProtocol` = `ctx@0bdbed65bcc4`
- 账本指纹（新增）= `lg@55deb2443649`（茶馆那份；换剧本会变）

数字（`eval/baseline/regression.json`）：

| 指标 | 值 | 分辨力 |
|---|---|---|
| 判定层 | 44/48（91.7%） | 端点为 48，稳定 |
| 端到端（命题级） | 25/48，K=3 各次 24–29 | 波动 ≈±10pp，**不能用来选版本** |
| R1 dev | P 50.0% [18.8–81.2] / R 30.0% [10.8–60.3] / cost 24（回合 40 起**可复现**：使用点走缓存，0 次判定） | 区间宽 50–60pp，**只能看大改**；两次读数差 1 条属判定噪声，≥2 条才算信号 |
| **真实剧本误报** | **7 条 / 269 使用点**（茶馆 72 场，零标注，chaguan@2，账本指纹 lg@294963d704e4） | 唯一有分辨力的指标；红线 **+2 条即回退**；回合 39 重建，旧 4/241 与 3/249 **作废** |
| 跨剧本留出集（回合 30 新增） | **P 2/7 = 28.6% [8.2–64.1] / R 2/10 = 20.0% [5.7–51.0]**，测试集 `leaks-jiuzhang@2#6f292ed74e5d` | 新基线，**只与它自己比**；测量时判定层是 openai-compat（见 §8.9） |
| **幻影专项集（回合 36 新增）** | **phantom（换说法）1/8 · anchored（沿用原话）4/8**；总 R 5/16 = 31.3% [14.2–55.6] / P 5/7 = 71.4% [35.9–91.8]，测试集 `leaks-phantom@2#e4077fa003ee` | **机制探针**，一条 = 6.25pp；只与它自己比，不做版本裁决 |
| 建账 | 23 场 14s（抽取 10.3s + 归并 4.5s） | — |
| 审计复跑 | 0.9s（首次 67.6s） | 使用点随账本落盘 |

**⚠️ 回合 30 的作废声明**：`eval/leaks-jiuzhang.json` v1 那轮的 P 50% / R 10% 作废（instrument 变了）。
dev 三行数字**不受影响**（dev 缓存 `eval/out/pipeline-leak.json` 未动）。
新集的判定层是 `openai-compat:deepseek-v4-pro`（JEV 区域封锁），归并粒度与历史 dev 不同源 ⇒ **跨集比 P/R 无效**。

**⚠️ `real` 只在「同一份冻结账本」上比较**：同一配置重抽两次，分别是 5 条和 4 条，报出清单几乎不重合。
重抽噪声 ≈±1~2 条，正好是红线的量级。跨抽取比较 `real` 一律算未定论。

## 3. 可复现命令

```bash
npx tsc --noEmit                                   # 类型检查（几乎每次改动后都跑）

# 单点指标
npx tsx eval/run-r1.ts                             # dev P/R（用 eval/out/pipeline-leak.json 缓存）
npx tsx eval/run-r1.ts --fresh                     # 重抽一次（≈1 分钟，会覆盖缓存）
AUDIT_SCRIPT=eval/script-chaguan.md \
AUDIT_CACHE=eval/baseline/pipeline-chaguan.json \
  npx tsx eval/run-audit.ts                        # real 指标（首次 67s，之后 0.9s）

# 产品路径
npx tsx eval/mcp-smoke.ts --fresh                  # 真的开一个 MCP 客户端走完八步

# 演示页数据（会重跑一次真实建账，约 20s，然后写 docs/data.json）
npx tsx eval/build-demo-data.ts

# 联合回归（很慢：--force-save 会多次重抽，30 分钟起。不要随手跑）
npx tsx eval/regression.ts --k 3 --force-save
```

跨剧本留出集（回合 30 已完成，`eval/leaks-jiuzhang.json` 10 条全 holdout）：

```bash
R1_SCRIPT=eval/script-jiuzhang-leak.md \
R1_LEAKS=eval/leaks-jiuzhang.json \
R1_JUDGE_PROVIDER=openai \
  npx tsx eval/run-r1.ts --fresh --holdout     # ≈7 分钟 / $0.42（23 场抽取 + 81 次判定）
npx tsx eval/validate-goldenset.ts eval/leaks-jiuzhang.json   # 标注的机械校验（含 established/learns_at）
```

## 4. 纪律（这是本项目真正的产出，别绕过）

- **两类回合**：`capability`（改抽取/规则，用 P/R/cost 裁决）vs `measurement`（改打分器/指标/匹配，
  不裁决优劣，但必须 ① 重建基线 ② 声明哪些历史结论作废 ③ 进实验库）。
- 每个回合都要进 `experiments/exp-XXX.json`（现有 31 条），文档记在 `docs/rsi-protocol.md`。
- 比例型指标一律带 **95% Wilson 区间**；配对比较用 **McNemar 精确检验**，不一致对 <6 不下结论。
- 改行为的新源文件必须同时登记进 `src/rsi/scorer.ts` 的 `SCORER_FILES` 与 `R1_FLAGS`，
  以及 `src/rsi/version.ts` 的 `RSI_FLAG_NAMES` —— 否则「这个数字是哪个版本跑出来的」会给出错误答案。
  这两处**各漏过一次**（回合 25、回合 28），都造成过失效绿灯。
- 红线：真实剧本误报 +2 条即回退；dev 指标不能退。

## 5. 已经被证伪 / 已推翻的自家结论（不要重复走）

1. 「DeepSeek 95.8% > JEV 91.7%」—— 差 2 条，McNemar p=0.50，噪声。
2. 「端到端 60.4%」—— 没钉配置的幸运抽样，钉死后 25/48。
3. 「`masked_by_presence` 修法」—— 试了 3 次都失败；修它会制造新误报，需要先有 `should_allow` 类规则。
4. 「公开事实规则（多人引用 ⇒ 常识）」—— dev 召回归零（循环论证），已删实现。
5. 「当事人规则（`patients` 字段）」—— 受控 A/B 零效果，且往主 prompt 加字段损伤抽取，已全部回退。
6. 「加 prompt 字段能提抽取质量」—— 三次（`established` / `patients` / 另一处）都变差。**不要再往主抽取 prompt 里堆字段**。
7. 「`real` 可以跨抽取比较」—— 见 §2，噪声与红线同量级。

## 6. 下一步（已定方向，动手前先读这一节）

### 6.1 跨剧本留出集（用户已选 B）— ✅ 回合 30 做完

`eval/script-jiuzhang-leak.md`（23 场，注入 10 条）+ `eval/leaks-jiuzhang.json`（10 条全 holdout、13 条 must_not_flag）
+ `eval/validate-goldenset.ts` 的泄漏集校验（surface 逐字在该场、泄漏者在该场在场、`established` 更早且泄漏者不在场、
`learns_at` 更晚且在场）+ `evalsets/index.json` 登记。

**这一集现在测出来的是什么**：漏报 8 条里 **7 条** 是同一机制 —— 注入台词被抽取成**一条新命题**，
于是「首见场景在场者得知」当场给泄漏者发了许可（`masked_by_presence`，与 §5.3 同一处）。
5 条误报里 4 条同源（同一事实被拆成两条命题）。**跨剧本集上的瓶颈是归并粒度，不是规则数量。**
下一步若继续攻它，先固定 provider（§8.9）再动 §5.3 那类修法，否则又在噪声上做实验。

**为什么必须跨剧本**：`eval/leaks.json` 的 meta 写明《旧账》正本（`eval/script-jiuzhang.md`）是
**内部自洽、零泄漏**的，`eval/script-leak.md` 是从它派生并注入 14 条泄漏的版本。原 holdout 的 4 条
与 dev 同剧本、同注入方式，而我在这份剧本上调了 20 多个回合 —— 密封性只是名义上的。

**做法（已成事实，供复核）**：10 条泄漏从零泄漏正本派生，全部 `split: "holdout"`；注入守三条：
① 事实在该角色不在场的更早场景里确立；② 台词不自陈来源；③ **surface ≥3 字**且复用确立场景的原话
（v1 用了换词 + 2 字 surface：抽取层在泄漏现场新建命题 ⇒ 10 条里 9 条被自我掩盖，另有多条被
`R1_MIN_SURFACE_LEN=3` 直接过滤掉）。

### 6.2 其余待办（按价值排序）

| 事项 | 说明 |
|---|---|
| **录屏（5 分钟）** | 硬要求还没做。建议脚本：① `mcp-smoke` 跑一遍真路径 ② 演示页三个 tab ③ 展示一次真实 `ledger_check` 拦截 + `waive` |
| **`npx -y` 可装** | 现在是本仓库内 `tsx` 启动。要能被 `npx -y <pkg> mcp` 直接跑，得打包（`tsup`/`esbuild` 出 dist + `bin` 指向 dist）。这是「挂到用户本地 agent」的最低门槛 |
| agents 召回 | 账本里 41%（11/27）命题 `agents` 为空 —— 这是「当事人」桶失效的根因。**新字段没用，是既有字段的抽取质量** |
| `type` 抽取 + 按类型分派规则 | 动作类走施事，状态类走持有者/当事人。改动面最大，放最后 |
| 茶馆的污染风险 | 《茶馆》是名篇，模型大概率见过 ⇒ `real=4` 可能偏乐观。补救方向：反事实改写（换人名地名、保留结构） |

下表是**上一版交接漏记、补齐的部分**（2026-10-18 核对）。前两项的价值高于上表：

| 事项 | 说明 |
|---|---|
| **跨剧本集的归并粒度（当前最大 headroom）** | 回合 30 实测：10 条漏报中 8 条命中、其中 **7 条同一机制** —— 注入台词被抽成一条**新命题**，于是「首见场景在场者得知」当场给泄漏者发了许可；5 条误报中 4 条也同源（同一事实被拆成两条命题）。结论：**瓶颈是归并粒度，不是规则数量**。动它之前先固定判定 provider（§8.9），否则是在降级噪声上做实验 |
| **`should_allow` 类规则** | `real` 剩的 4 条里有 2 条是「公开事实」，正是这类规则的目标；回合 21 已排出顺序：**先补 should_allow，再对归类做修法**，否则修法一上线就被新误报吞掉。这条至今没做 |
| 真实客户端实测（DSH / Claude Code） | 只有 `mcp-smoke`（SDK 客户端）。要在 DSH 与 Claude Code 里各连一次，各跑一次 `check` + `audit`，把配置与截图写进 README —— 这是「挂到用户自己的剧本 agent 上」这句话的证据 |
| 判定层 4 条错例 | 44/48 里那 4 条**从没逐条分析过**，可能有非噪声成因（`docs/rsi-log.md` 只记了 v0→v3 的过程） |
| e2e 波动的收敛 | 各次 24–29（±10pp）。修法是把 e2e 改成 K 次平均并报 Wilson 区间，否则它永远只能看趋势、不能选版本 |
| run-r1 未接第三条通道 | MCP 的 `ledger_audit` 与 `run-audit` 已接（复跑 0.9s），但 `eval/run-r1.ts` 没接 —— dev 每跑一次仍重跑 253 次判定（≈63s），且判定抖动直接进 dev 数字 |
| `eval/script-chaguan.md` 导入器噪声 | 有 2 处人物表残留被当成台词，会污染 `real` 的使用点统计（量小，但它落在唯一有分辨力的指标上） |
| 许可证 | 仓库没有 `LICENSE`（README 写「未定」）。对外交付前必须定，否则别人不能合法使用 |
| 磁盘上的 `.env.bak` | 含真 key，已 gitignore 但**仍在工作目录**；建议直接删掉（§8.8 只说了「不要提交」） |

## 7. 代码地图

| 路径 | 职责 |
|---|---|
| `src/mcp/server.ts` | 六个工具。`ledger_ingest` 是**按块抽取 + 只归并一次**（逐场归并会平方爆炸），可续跑 |
| `src/audit/r1.ts` | `buildUsages` / `defaultKnowledge` / `detectLeaks` / `liftToUnits` / `auditOnUnits` |
| `src/audit/usage-verify.ts` | 判定层对每个候选使用点问「真引用还是碰巧共享词」 |
| `src/audit/usage-cache.ts` | **第三条回写通道**：使用点随账本落盘，三项戳（打分器/上下文/账本指纹）命中即复用 |
| `src/extraction/extractor.ts` | 逐场抽取，**有界并发**（`EXTRACT_CONCURRENCY`，默认 4），**默认关思考** |
| `src/extraction/merge.ts` | 归并（bigram blocking + JEV 判定） |
| `src/rsi/metrics.ts` | `wilson` / `computeMetrics` / `judgeCandidate`（含精确率护栏与 devSet 闸） |
| `src/rsi/version.ts` · `scorer.ts` | 版本指纹与打分器清单 |
| `eval/` | 所有评测脚本；`eval/leaks.json` 是标注，`eval/leaks-jiuzhang.json` 是跨剧本留出集标注，`eval/baseline/` 是冻结基线 |

## 8. 环境坑（踩过的，别再踩）

1. **`pwsh` 管道会缓冲**：`npx tsx ... | Select-Object -Last 20` 在命令结束前什么都不显示，
   长任务看起来像卡死。一律 `*> 文件` 重定向，再 tail 文件。
2. `src/mcp/server.ts` 第一行必须是 `#!/usr/bin/env node`；用脚本插 import 时曾把它挤到第 4 行，
   报 `TS18026: '#!' can only be used at the start of a file`。
3. `web_fetch` 对 GitHub / arxiv 全部失败（hosts 把 23 个 GitHub 域名指到 127.0.0.1）；
   取公开材料用 `gh api` / `git clone`。
4. PowerShell 双引号里的 `$` 与反引号会被吃掉；多行文本用 here-string，且终止符 `'@` 必须独占一行。
5. MCP 客户端默认请求超时 60s（SDK `-32001`）。任何可能超过 45s 的工具都必须分块 + 落盘 + 可续跑。
6. 抽取关思考后单场 2s；**开着是 47s / $0.0162**（54 字）。不要在不知情的情况下打开它。
7. `npx tsc --noEmit` 的 `noUnusedLocals` 会因残留变量报错 —— 删代码时连变量一起删。
8. `.env` 里有真 key，已 gitignore；`.env.bak` 曾在历史里出现过，已从历史移除。**不要再提交任何 .env**。
9. **TypeSafe 直连（JEV）会按地区 451 拒答**（`Typesafe is not available in your region`）。它在管线里是
   **静默降级**：`mergeScenes` 每次失败都退回 `NEW`、`verifyUsages` 每次失败都保留使用点，于是 run-r1 照旧
   打印一个像样的 P/R，而账本一条没归并。回合 30 已加失败计数（`judgeWatch`）：降级即中止、且不写缓存。
   替代：`R1_JUDGE_PROVIDER=openai` 走 `OpenAiCompatProvider`（DeepSeek），它同时是**归并粒度不同的另一套账本**，
   数字与历史 dev 不可比。先 `npx tsx` 探一下 JEV 今天通不通再决定，别在降级结果上做实验。
10. `R1_LEAKS` 换了标注集却共用 `pipeline-leak.json` 时，一次 `--fresh` 会把 dev 的抽取缓存覆盖掉（此后 dev 数字
    静默变成另一份剧本的）。缓存名现在跟着标注集走（`pipeline-<leaks名>.json`），`R1_CACHE` 仍可显式覆盖。


## 9. 回合 31–34 的结论与新增开关（2026-10-18）

四条此前不在本项目里的能力，**全部默认关闭**，只在 `experiments/exp-031..034.json` 里有记录：

| 开关 | 做什么 | 状态 |
|---|---|---|
| `R1_MERGE_EXACT`（`=1`） | 逐字相同说法强制归并，唯一命中才短路判官 | dev 只触发 1 次、指标不变；默认关 |
| `R1_NO_SELF_ESTABLISH`（`1` / `single` / `later`） | 不拿自己的台词当自己的知情来源；`later` 只在「更晚场次他也在场」时收回 | `later` 在 dev 上 +2TP 不增误报，但在 holdout 上 +1TP/+3FP；默认关 |
| `R1_SHOULD_ALLOW`（`=1`） | 词表豁免：自陈来源标记（跟我说/告诉我/我亲眼…）+ 前提性知识（剧本头部声明的重生者知道闪回里的事） | 吸收 2 条误报，dev 上不可见；默认关 |
| `R1_LEAK_JUDGE`（`=1`） | 判定层豁免：只对已报出的候选问一次「当事人/目击/被专门告知/公开信息」 | 误报砍半但放过真泄漏，单次审计多 470s；默认关 |
| `R1_MERGE_OVERLAP`（回合 37 加、**回合 38 翻为默认开启**，`=0` 回退） | 归并层确定性一层：两条说法共享 ≥6 字连续片段（`R1_MERGE_OVERLAP_MIN`）且唯一命中时直接挂上去、不交判官 | 茶馆冻结抽取上 A/B：real 4→3 条（264→256 命题，未越 +2 红线）；dev 40/20/cost27 → 50/30/cost24（配对 1 对，不做显著声明）；幻影集 anchored 4/8→7/8 |

**评测模式新增 `--remerge`**：冻结抽取、只重跑归并。归并层改动只能这样验；
R1 层（knowledge/usage）改动用 `--reuse`。**两者不可混比** —— dev 的归并不可复现
（同配置 `--remerge` 两次，tp 得到 3 和 2）。

**留出集已解封 3 次**（对照 tp2/fp5、later tp3/fp8、later+SA tp3/fp6、all+SA+judge tp4/fp12），
四种变体没有一个通过 `tp≥6 且 fp≤5`。**再用就不是留出集了** —— 修复方向已被证明卡在
「测量分辨力」而非代码上，详见 `docs/rsi-round.md` 轮次 31 的最终裁决。

**注意打分器戳已变**：`r1@5c4757558d19` → 之后因新开关进 `R1_FLAGS` 而变过，
茶馆的使用点缓存随之作废，那几次 `real` 都是新抽样（**5 条 / 240 使用点**，
与 4/241 差 1 条，在 §2 记录的 ±1~2 噪声带内）。

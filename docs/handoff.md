# 交接说明（handoff）

> 写给「下一个会话的自己」和任何接手的人。目标是：**不读对话历史也能继续做**。
> 最后更新：回合 29 之后。

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
| R1 dev | P 50.0% [18.8–81.2] / R 30.0% [10.8–60.3] / cost 24 | 区间宽 50–60pp，**只能看大改** |
| **真实剧本误报** | **4 条 / 241 使用点**（茶馆 72 场，零标注） | 唯一有分辨力的指标；红线 **+2 条即回退** |
| 建账 | 23 场 14s（抽取 10.3s + 归并 4.5s） | — |
| 审计复跑 | 0.9s（首次 67.6s） | 使用点随账本落盘 |

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

跨剧本留出集（下一个回合要用，`R1_LEAKS` 已加好）：

```bash
R1_SCRIPT=eval/script-jiuzhang-leak.md \
R1_LEAKS=eval/leaks-jiuzhang.json \
  npx tsx eval/run-r1.ts --fresh --holdout
```

## 4. 纪律（这是本项目真正的产出，别绕过）

- **两类回合**：`capability`（改抽取/规则，用 P/R/cost 裁决）vs `measurement`（改打分器/指标/匹配，
  不裁决优劣，但必须 ① 重建基线 ② 声明哪些历史结论作废 ③ 进实验库）。
- 每个回合都要进 `experiments/exp-XXX.json`（现有 30 条），文档记在 `docs/rsi-protocol.md`。
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

### 6.1 跨剧本留出集（用户已选 B）

**为什么必须跨剧本**：`eval/leaks.json` 的 meta 写明《旧账》正本（`eval/script-jiuzhang.md`）是
**内部自洽、零泄漏**的，`eval/script-leak.md` 是从它派生并注入 14 条泄漏的版本。现有 holdout 的 4 条
与 dev 同剧本、同注入方式，而我在这份剧本上调了 20 多个回合 —— 再加 6 条进去，密封性只是名义上的。

**做法**：

1. 从零泄漏正本 `eval/script-jiuzhang.md`（23 场，已读过全文）派生 `eval/script-jiuzhang-leak.md`，
   注入 **10 条**泄漏。注入时守两条规矩（v1 踩过的坑）：
   - 被泄漏的**事实必须在该角色不在场的更早场景里确立**，否则「首见场景在场者得知」会把它自己掩盖掉；
   - 注入的台词里**不要自陈来源**（不要写「XX 告诉过我」），否则等于自己给自己发了许可。
2. 写 `eval/leaks-jiuzhang.json`，schema 与 `eval/leaks.json` 一致：
   `{ meta, leaks: [{id, kind: no_source|timing, character, scene, surface, why, exact_scene, split}], must_not_flag: [...] }`，
   全部 `split: "holdout"`。`surface` 必须是剧本原文里逐字出现的片段，且能对上账本里的说法。
3. 同时标 **8 条以上 `must_not_flag`**（应当放过）：`九章` 是自洽正本，它的价值在精确率 ——
   尤其要标「重生者沈知微的预知」这类**合法知道**（她作为重生者知道前世的事，不该被报）。
4. 跑 `npx tsx eval/validate-goldenset.ts` 做机械校验（别名是否逐字出自剧本），再跑上面的 `--holdout` 命令。
5. 记为 `exp-030`，`kind: measurement`（新增测试集 ⇒ 旧数字作废、必须重建基线）。

### 6.2 其余待办（按价值排序）

| 事项 | 说明 |
|---|---|
| **录屏（5 分钟）** | 硬要求还没做。建议脚本：① `mcp-smoke` 跑一遍真路径 ② 演示页三个 tab ③ 展示一次真实 `ledger_check` 拦截 + `waive` |
| **`npx -y` 可装** | 现在是本仓库内 `tsx` 启动。要能被 `npx -y <pkg> mcp` 直接跑，得打包（`tsup`/`esbuild` 出 dist + `bin` 指向 dist）。这是「挂到用户本地 agent」的最低门槛 |
| agents 召回 | 账本里 41%（11/27）命题 `agents` 为空 —— 这是「当事人」桶失效的根因。**新字段没用，是既有字段的抽取质量** |
| `type` 抽取 + 按类型分派规则 | 动作类走施事，状态类走持有者/当事人。改动面最大，放最后 |
| 茶馆的污染风险 | 《茶馆》是名篇，模型大概率见过 ⇒ `real=4` 可能偏乐观。补救方向：反事实改写（换人名地名、保留结构） |

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
| `eval/` | 所有评测脚本；`eval/leaks.json` 是标注，`eval/baseline/` 是冻结基线 |

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

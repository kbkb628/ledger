# 《账本》— AI 短剧的叙事一致性账本

> 检测「角色用了还不该知道的信息」，并把硬伤折算成重做代价。
>
> **形态是一个 MCP server**：挂到你本地的剧本创作 agent 上，写台词的当下就被拦住。

**在线演示**：https://kbkb628.github.io/ledger/ （静态快照，数据由真实 MCP 调用生成）

## 它解决什么

AI 短剧的生产工具已经很多，但它们管的是**成本**：花了多少钱、哪一步要重做、改了这里会坏哪里。
**没人管「故事讲得对不对」。**

一个典型的硬伤：

```
第 2 集  沈知微：你三年前在码头做了什么，你自己清楚。
第 3 集  （闪回）才知道当年发生了什么
```

编剧看得出，机器看不出来——因为判断它需要**跨全剧的认知状态**：谁在第几场知道了什么。
这正是 skill / 提示词做不到的（它们上下文隔离、没有可寻址的持久状态）。
所以账本做成一个常驻的 MCP server。

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 JEV_API_KEY 与 JUDGE_API_KEY，见下
npm run mcp               # 仓库内开发用：tsx 直接起 server（stdio）
```

打包成可安装的 MCP server（`bin` → `dist/mcp.js`，esbuild 单文件，约 76 KB）：

```bash
npm run build                       # → dist/mcp.js
npm pack                            # → ledger-0.1.0.tgz（prepack 会自动构建）
npx -y ./ledger-0.1.0.tgz           # 在任意目录里就能起 server
```

`package.json` 里 `bin: { "ledger-mcp": "dist/mcp.js" }`、`files: ["dist"]`，
所以装出来的包只需要 node ≥20，不需要 tsx，也不需要在仓库里。

> **当前还没有发布到 npm registry**（`private: true`），所以现在只能从 `npm pack` 出来的 tgz 安装；
> `npx -y ledger-mcp` 这种写法要等发布之后才成立。

### 需要的两个 key

| 变量 | 用途 | 说明 |
|---|---|---|
| `JEV_API_KEY` | 归并判定（TypeSafe System One） | $42 / 10 亿 input token，实测 **$0.045 / 1000 次** |
| `JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL` | 抽取与知识状态 | DeepSeek 兼容接口即可 |

判定层选 JEV 是因为它**只返回决策概率**、延迟 230ms、成本低两个数量级，
实测在黄金集上 44/48（91.7%，JEV 时代基线；换成 DeepSeek 兼容判定器最近一次复跑是 45/48 = 93.8%，两者差 1 条在噪声带内），延迟比 LLM 判定器低两个数量级。
详见 `docs/rsi-log.md`。

## 挂到本地 agent 上

两条接入方式都在本机真连过，配置与输出见本节末尾的「接入记录」。密钥一律走环境变量或 `.env`，
**不要写进配置文件** —— server 启动时会读 `cwd/.env`（`src/mcp/server.ts` 的 `loadEnv`），
所以把 `cwd` 指到你自己的剧本目录、在那放一份 `.env` 就够了。

### DeepSeek Harness（DSH）

写进当前 profile 的 `cordis.patch.yml`（本机路径 `~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-ledger
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ledger
        transport: stdio
        command: node
        args: ['E:\恺英\dist\mcp.js']      # 换成你的路径；用打包产物，不要指向 src
        cwd: 'E:\恺英'                     # server 从这个目录读 .env 与 .ledger
        toolCallTimeoutMs: 180000          # 整本建账约 14–40 秒，默认 60 秒偏紧
```

工具随后以 `mcp__ledger__ledger_check` 这类名字出现在模型工具表里。**改动需要重启 harness 生效**
（`patchReload: live` 对新会话生效，已在跑的会话工具表不会热插）。

### Claude Code / Cursor / 其他 MCP 客户端

Claude Code 一行：

```bash
claude mcp add --scope user ledger \
  node /abs/path/to/node_modules/ledger/dist/mcp.js \
  -e JEV_API_KEY=... -e JEV_BASE_URL=... -e JEV_MODEL=... -e LEDGER_HOME=/abs/path/to/.ledger
```

> `-e` 是可变参数，**必须放在命令后面**，否则会把 `<name>` 一起吃掉（实测报 `missing required argument`）。

其他 MCP 客户端的等价 JSON：

```json
{
  "mcpServers": {
    "ledger": {
      "command": "node",
      "args": ["/abs/path/to/node_modules/ledger/dist/mcp.js"],
      "env": { "LEDGER_HOME": "/abs/path/to/script-project/.ledger" }
    }
  }
}
```

装好后工具以 `mcp__ledger__*` 出现。

### 接入记录（本机实测，2026-10-18）

**① 空目录里从 tgz 装起来跑完整路径**（`npm run npx:smoke`，临时目录在仓库之外、未设 `LEDGER_HOME`）：

```
打包：ledger-0.1.0.tgz（27 KB）
✅ listTools 返回 6 个工具 — ledger_ingest,ledger_record,ledger_check,ledger_audit,ledger_page,ledger_waive
✅ ledger_ingest 建成账本 — 13s · {"ok":true,"series":"default","ledgerPath":"…\Temp\ledger-npx-1D9Cpg\.ledger\default\…”}
✅ 账本落在 cwd/.ledger（未设 LEDGER_HOME）
✅ check 拦住泄漏台词 — ⚠️ 1 处泄漏：「你三年前在码头做了什么」→ 陆见深三年前在码头做了某件事
✅ check 放过正常台词
```

**② Claude Code**：`claude mcp get ledger` → `Status: ✓ Connected`（`node …/node_modules/ledger/dist/mcp.js`，
env 四项齐全）。注意 `claude -p` 由模型发起工具调用需要先在 CLI 里 `/login`；本机未登录，
所以上面第 ① 条的真实拦截输出是用 MCP SDK 客户端在**同一个安装产物**上取到的。

**③ DSH**：配置写入 `~/.dsh/profiles/desktop/cordis.patch.yml`（上面那段）后重启 harness，
`mcp__ledger__ledger_check` 进入工具表（配置里不写 key 的原因见本节开头）。真实的模型侧调用：

```
ledger_check { line: "你三年前在码头做了什么？", character: "沈知微", scene: "S02-02" }
→ { "leak": true,
    "hits": [{ "propositionId": "E-002",
               "canonical": "陆见深三年前在码头做了某件事",
               "surface": "你三年前在码头做了什么",
               "knownAt": null, "waived": false,
               "reason": "全剧没有记录 沈知微 得知过这条命题" }] }
```

## 六个工具

| 工具 | 作用 |
|---|---|
| `ledger_ingest` | 首次建账（抽取命题与知识状态并**冻结**）。**分块可续跑**：一次调用没建完会返回剩余场次，用同样的 `script` 再调一次即可接着建 |
| `ledger_record` | 把**一场**新戏增量并入已有账本（不重扫全本） |
| **`ledger_check`** | **写完一句台词之前调用** —— 判断是否会构成知识泄漏 |
| `ledger_audit` | 全剧泄漏清单 |
| `ledger_page` | 读一个账本词条（wiki 形态：说法、首见场景、知识记录、判决流水） |
| `ledger_waive` | 人工豁免误报，理由进判决流水 |

典型用法（agent 侧）：

```
写手想写：苏婉：那笔钱我早就处理了
→ 调用 ledger_check { line: "苏婉：那笔钱我早就处理了", character: "苏婉", scene: "S19-02" }
← { leak: true, hits: [{ surface: "那笔钱", canonical: "苏婉转移了那笔钱",
                          reason: "全剧没有记录 苏婉 得知过这条命题" }] }
```

## 账本落在哪

```
LEDGER_HOME（绝对路径）  >  <cwd>/.ledger
```

```
<剧本项目>/.ledger/default/
├── ledger.json      # 主账本：命题 + 说法 + 知识状态 + 豁免（人可读、可 diff）
└── decisions.jsonl  # append-only 判决流水（谁在何时为什么做了这个判决）
```

放**项目目录**而不是 agent 私有目录，因为账本是项目资产：要能 review、能进 git、
换一个 agent 也看得见。每次工具调用都会回显 `ledgerPath`。

## 验收与实验

```bash
npm run mcp:smoke        # 用真的 MCP 客户端走一遍完整用户路径
npm run audit            # CLI 跑全剧 R1 审计
npm run eval:validate    # 黄金集机械校验（别名是否逐字出自剧本等）
npm run eval:e2e         # 端到端准确率
npm run eval             # 判定层单点评测
```

当前实测数字（都在 `docs/test-log.md` 里有可复现的命令与版本戳）：

| 指标 | 值 | 备注 |
|---|---|---|
| 判定层（人工账本） | **44/48（91.7%，JEV 时代基线）** / **45/48（93.8%，openai 兼容判定器最近一次复跑）** | 端点级；两者差 1 条在噪声带内 |
| 端到端（抽取账本，命题级） | **均值 25.67/48（53.5%）**，K=3 各次 27/25/25 | **95% Wilson 39.6–66.8%**：区间 27pp，单次读数没有裁决权 |
| R1 精确率 / 召回率（dev 10 条标注） | **50.0% / 30.0%**（cost 24） | 95% Wilson：18.8–81.2% / 10.8–60.3%；区间很宽，**不用它选版本** |
| 真实剧本误报（茶馆 72 场，零标注） | **7 条 / 269 使用点**（`chaguan@2`） | 专业剧本自洽 ⇒ 报出即误报；**唯一有分辨力的指标**，只在同一份冻结账本上比 |
| 跨剧本留出集（《旧账》系另一份正本） | **P 28.6% / R 20.0%**（10 条，全 holdout） | 只与它自己比；已解封 3 次，不再用于选版本 |
| 幻影专项集（同一事实两种说法） | phantom **1/8** · anchored **7/8** | 机制探针：换了说法就抓不到 |
| 建账（23 场） | **14s**（抽取 10.3s + 归并 4.5s） | 抽取默认关思考；分块可续跑 |
| 审计复跑 | **0.9s**（首次 67.6s） | 使用点已随账本落盘，命中版本戳即复用 |

三条**自己推翻过自己**的结论，也一并写在这里（它们比上面的数字更能说明这套流程在做什么）：

1. 「DeepSeek 95.8% > JEV 91.7%」—— 差 2 条样本，McNemar p=0.50，是噪声。
2. 「端到端 60.4%」—— 没钉配置的幸运抽样；钉死后是 25/48。
3. 「某改动让真实剧本误报从 9 条降到 3 条」—— 重抽两次发现噪声本身就有 ±1~2 条，
   所以 `real` 只在**同一份冻结账本**上比较才有意义。

**已知限制（诚实说明）**：R1 的封闭世界假设目前误报偏高，所以 `ledger_waive`
不是补丁而是产品的一环。默认知识层已实现一条规则（施事知道自己做的事），
剩余成因与改进顺序记在 `docs/rsi-protocol.md` 的回合记录里。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/design.md` | 总体设计：认知层、事件同一性、三层路由、promotion 层、审计规则 |
| `docs/extraction-schema.md` | 抽取层字段定义（含「证据 / 索引 / 审计必需」三级分类） |
| `docs/rsi-protocol.md` | **主文档**：RSI 纪律（两类回合、红线、三个版本戳）与 29 个回合的完整记录，含被自己推翻的结论 |
| `docs/testset.md` | 测试集规范、演进日志、样本量计算、外部实践借鉴 |
| `docs/rsi-log.md` | 判定层的 RSI 迭代记录（v0→v3，含效度教训） |
| `docs/test-plan.md` | 测试计划、已完成实验与结论、失败分类、headroom 排序 |
| `docs/handoff.md` | 交接说明：当前基线、可复现命令、下一步与已知坑 |
| `docs/next-steps.md` | 工作单：剩下的活、推荐顺序、每项的验收标准与「不要做的事」 |

## 技术栈

- TypeScript + `tsx`（无构建步骤）
- `@modelcontextprotocol/sdk`（stdio 传输）
- 判定：TypeSafe JEV（决策概率）· 抽取：DeepSeek 兼容接口
- 存储：JSON + JSONL 文件（无数据库）

## 许可

未定。
| `docs/rsi-round.md` | 每轮迭代的目标书（范围→目标→评测器→历史路径包），`/goal` 的依据 |

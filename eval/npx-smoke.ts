/**
 * P0-2 验收：**在空目录里**用 `npx -y <tgz>` 装起来，并用真 MCP 客户端走一遍
 * listTools → ledger_ingest → ledger_check（泄漏 / 正常各一条）。
 *
 * 为什么不用仓库内的 `npx tsx src/mcp/server.ts`：那条路要求装了 tsx 且 cwd 在仓库里，
 * 而产品的整个卖点是「挂到你**自己的**剧本 agent 上」。这里刻意：
 *   - 目录在系统临时目录下（仓库之外、空的）；
 *   - 不设 `LEDGER_HOME`，验证默认 `cwd/.ledger` 在包外仍然成立；
 *   - 通过 npm 打的 tgz 安装，走 `bin` 指向的 `dist/mcp.js`（不是 src）。
 *
 * 用法：npm run npx:smoke   （会先 npm pack，触发 prepack → esbuild 打包）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NPM_CACHE = join(root, ".npm-cache");

interface ToolText { content: Array<{ type: string; text?: string }>; isError?: boolean }

function payload(r: unknown): Record<string, unknown> {
  const t = (r as ToolText).content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { raw: t };
  }
}

/** 把仓库打进一个 tgz（prepack 会自动 build，所以包里一定有 dist/mcp.js） */
function pack(dest: string): string {
  // Windows 上直接 spawn "npm" 会 ENOENT（那是 npm.cmd），也别指望 .cmd 能被无 shell 调用；
  // 有 npm run 时拿 npm_execpath 最稳，否则退回 node <npm-cli.js>
  const npmCli = process.env.npm_execpath;
  const [cmd, args] = npmCli
    ? [process.execPath, [npmCli]]
    : ["npm", []];
  const out = execFileSync(cmd as string, [...(args as string[]), "pack", "--pack-destination", dest, "--cache", NPM_CACHE], {
    cwd: root,
    encoding: "utf8",
  });
  const tgz = out.trim().split(/\r?\n/).filter((l) => l.endsWith(".tgz")).pop();
  if (!tgz) throw new Error(`npm pack 没有产出 tgz：${out.slice(0, 200)}`);
  return join(dest, tgz.replace(/^.*[\\/]/, ""));
}

const checks: Array<{ name: string; ok: boolean; note: string }> = [];
function check(name: string, ok: boolean, note = ""): void {
  checks.push({ name, ok, note });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${note ? ` — ${note}` : ""}`);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "ledger-npx-"));
  console.log(`\n空目录：${work}`);
  const tgz = pack(work);
  console.log(`打包：${tgz.split(/[\\/]/).pop()}（${(readFileSync(tgz).length / 1024).toFixed(0)} KB）`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "LEDGER_HOME") env[k] = v;
  }
  // 空目录里的用户是自己配 key 的（名字见 README）；这里从仓库 .env 借一下，只进子进程环境
  for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !env[m[1]!]) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  // npx 自己也要写缓存：默认位置在本机是只读的（EPERM），指到仓库里已 gitignore 的那个
  env.npm_config_cache = NPM_CACHE;

  const transport = new StdioClientTransport({
    command: "npx",
    // ⚠️ 必须用**相对** spec：`npx -y C:\...\ledger-0.1.0.tgz` 在 Windows 上会静默什么都不做
    // （exit 0、无输出），客户端只会看到 `-32000 Connection closed`。相对路径 + cwd 才行。
    args: ["-y", `./${tgz.replace(/^.*[\\/]/, "")}`],
    cwd: work,
    env,
    // pipe 而不是 inherit：子进程如果连不起来，stderr 才是唯一线索（-32000 什么也不说）
    stderr: "pipe",
  });
  transport.stderr?.on("data", (b: Buffer) => {
    for (const l of b.toString("utf8").split(/\r?\n/)) if (l.trim()) console.log(`    [server] ${l}`);
  });
  const client = new Client({ name: "ledger-npx-smoke", version: "0" }, { capabilities: {} });
  await client.connect(transport);

  // ── 1. 工具面 ──
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  const want = ["ledger_ingest", "ledger_record", "ledger_check", "ledger_audit", "ledger_page", "ledger_waive"];
  check("listTools 返回 6 个工具", names.length === 6 && want.every((w) => names.includes(w)), names.join(","));

  // ── 2. 建账（真抽取 + 真归并，约 15–35s）──
  const LONG = { timeout: 240_000 };
  const script = readFileSync(join(here, "script-jiuzhang.md"), "utf8");
  const t0 = Date.now();
  console.log(`\n[ingest] ${script.length} 字符 / 23 场 …`);
  const ing = payload(await client.callTool({ name: "ledger_ingest", arguments: { script } }, undefined, LONG));
  const secs = Math.round((Date.now() - t0) / 1000);
  check("ledger_ingest 建成账本", !(ing as { error?: string }).error, `${secs}s · ${JSON.stringify(ing).slice(0, 120)}`);

  // ── 3. 默认 LEDGER_HOME = cwd/.ledger（包外仍成立）──
  const home = join(work, ".ledger");
  const ledgerFiles = existsSync(home) ? readdirSync(home) : [];
  check("账本落在 cwd/.ledger（未设 LEDGER_HOME）", existsSync(home) && ledgerFiles.length > 0, ledgerFiles.join(","));

  // ── 4. check：应当被拦住的一条 ──
  const bad = payload(
    await client.callTool({
      name: "ledger_check",
      arguments: { line: "你三年前在码头做了什么？", character: "沈知微", scene: "S02-02" },
    }),
  );
  check("check 拦住泄漏台词", bad.leak === true, String(bad.summary ?? "").slice(0, 120));

  // ── 5. check：应当放过的一条 ──
  const good = payload(
    await client.callTool({ name: "ledger_check", arguments: { line: "这块表你收好。", character: "沈知微" } }),
  );
  check("check 放过正常台词", good.leak === false, String(good.summary ?? "").slice(0, 120));

  await client.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项未通过`}（空目录 ${work}）`);
  if (failed.length) process.exitCode = 1;
}

await main();

/**
 * MCP server 冒烟测试 —— 用真的 MCP 客户端连上去，走一遍完整用户路径。
 *
 *   ledger_audit（无账本）→ ledger_ingest → ledger_check（泄漏/正常两条）
 *   → ledger_audit → ledger_waive → ledger_audit（应减少）→ ledger_page
 *
 * 这不是单元测试，是**产品验证**：证明「本地 agent 通过 MCP 在写台词时被拦住」这条路是通的。
 *
 * 用法：npx tsx eval/mcp-smoke.ts
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const HOME = process.env.LEDGER_HOME ?? join(root, ".ledger");

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.LEDGER_HOME = HOME;

interface ToolText { content: Array<{ type: string; text?: string }>; isError?: boolean }

function payload(r: unknown): Record<string, unknown> {
  const t = (r as ToolText).content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { raw: t };
  }
}

async function main(): Promise<void> {
  if (existsSync(HOME) && process.argv.includes("--fresh")) rmSync(HOME, { recursive: true, force: true });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    cwd: root,
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "ledger-smoke", version: "0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`\n可用工具 ${tools.tools.length} 个: ${tools.tools.map((t) => t.name).join(", ")}`);

  // ── 1. 没有账本时 check 应该给出可操作的错误 ──
  const before = payload(
    await client.callTool({ name: "ledger_check", arguments: { line: "那是一笔钱", character: "苏婉" } }),
  );
  console.log(`\n[1] 无账本时 check → ${String(before.raw).slice(0, 60)}`);

  // ── 2. 建账 ──
  const script = readFileSync(join(here, "script-jiuzhang.md"), "utf8");
  console.log(`\n[2] ledger_ingest（${script.length} 字符，约 30-40 秒）…`);
  const t0 = Date.now();
  const ing = payload(await client.callTool({ name: "ledger_ingest", arguments: { script, overwrite: true } }));
  console.log(`     ${Math.round((Date.now() - t0) / 1000)}s →`, JSON.stringify(ing));

  // ── 3. 冻结不变量：重复 ingest 必须被拒绝 ──
  const again = await client.callTool({ name: "ledger_ingest", arguments: { script } });
  console.log(`\n[3] 重复 ingest → ${(again as ToolText).isError ? "已拒绝 ✓" : "⚠️ 竟然成功了"}`);

  // ── 4. check：一条应当泄漏的台词 ──
  const leak = payload(
    await client.callTool({
      name: "ledger_check",
      arguments: { line: "沈知微：你三年前在码头做了什么，你自己清楚。", character: "沈知微", scene: "S02-02" },
    }),
  );
  console.log(`\n[4] check 泄漏台词 → leak=${String(leak.leak)}`);
  console.log(`     ${String(leak.summary)}`);

  // ── 5. check：一条正常的台词 ──
  const ok = payload(
    await client.callTool({
      name: "ledger_check",
      arguments: { line: "陈默：那份原件，我一直留着。", character: "陈默", scene: "S14-01" },
    }),
  );
  console.log(`\n[5] check 正常台词 → leak=${String(ok.leak)}`);
  console.log(`     ${String(ok.summary)}`);

  // ── 6. 全剧审计 ──
  const audit = payload(await client.callTool({ name: "ledger_audit", arguments: {} }));
  const issues = (audit.issues as Array<Record<string, unknown>>) ?? [];
  console.log(`\n[6] ledger_audit → ${String(audit.count)} 条问题`);
  for (const i of issues.slice(0, 3)) {
    console.log(`     ${String(i.scene)} ${String(i.character)}「${String(i.surface)}」→ ${String(i.canonical).slice(0, 26)}`);
    console.log(`       ${String(i.reason)}`);
  }

  // ── 7. 豁免一条，再审计应减少 ──
  if (issues.length > 0) {
    const first = issues[0]!;
    const w = payload(
      await client.callTool({
        name: "ledger_waive",
        arguments: {
          character: String(first.character),
          propositionId: String(first.propositionId),
          reason: "冒烟测试：人工确认为误报",
        },
      }),
    );
    const audit2 = payload(await client.callTool({ name: "ledger_audit", arguments: {} }));
    console.log(`\n[7] 豁免 ${String(w.key)} → 审计 ${String(audit.count)} → ${String(audit2.count)} 条`);
    console.log(`     ${Number(audit2.count) === Number(audit.count) - 1 ? "减少 1 条 ✓" : "⚠️ 未按预期减少"}`);
  }

  // ── 8. 读词条（wiki 形态） ──
  const page = payload(
    await client.callTool({ name: "ledger_page", arguments: { propositionId: String(issues[0]?.propositionId ?? "E-001") } }),
  );
  console.log(`\n[8] ledger_page ${String(page.id ?? "?")} → ${String(page.canonical ?? "").slice(0, 40)}`);
  console.log(`     说法 ${((page.aliases as unknown[]) ?? []).length} 条 · 知识记录 ${((page.knowledge as unknown[]) ?? []).length} 条`);

  console.log(`\n账本落在：${HOME}`);
  await client.close();
  console.log("");
}

await main();

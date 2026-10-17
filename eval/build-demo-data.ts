/**
 * 生成静态演示页的数据：**真的连 MCP server 跑一遍**，把工具返回值原样落成 JSON。
 *
 * 演示页不重新推理、不编数据 —— 页面上每一条都是某次真实调用的返回。
 * 输出：docs/data.json（与 docs/index.html 同源，GitHub Pages 直接 fetch）
 *
 * 用法：npx tsx eval/build-demo-data.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const HOME = join(root, ".ledger");
const LONG = { timeout: 180_000 };

interface ToolText { content: Array<{ type: string; text?: string }>; isError?: boolean }

function payload(r: unknown): Record<string, unknown> {
  const t = (r as ToolText).content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { raw: t };
  }
}

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.LEDGER_HOME = HOME;

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp/server.ts"],
  cwd: root,
  env,
  stderr: "inherit",
});
const client = new Client({ name: "ledger-demo", version: "0" }, { capabilities: {} });
await client.connect(transport);

const script = readFileSync(join(here, "script-jiuzhang.md"), "utf8");

const t0 = Date.now();
const ingest = payload(await client.callTool({ name: "ledger_ingest", arguments: { script, overwrite: true } }, undefined, LONG));
const ingestMs = Date.now() - t0;

// 三个真实的 check 调用：一个应当拦住，一个应当放过，一个豁免后放过
const scenarios = [
  { key: "leak", label: "写手想写：你三年前在码头做了什么", args: { line: "你三年前在码头做了什么？", character: "沈知微", scene: "S02-02" } },
  { key: "ok", label: "写手想写：这块表你收好", args: { line: "这块表你收好。", character: "沈知微", scene: "S01-03" } },
  { key: "other", label: "写手想写：老爷留下的东西在谁手上", args: { line: "老爷留下的那份东西，如今在谁手上？", character: "苏婉", scene: "S04-03" } },
];
const checks: Record<string, unknown> = {};
for (const s of scenarios) checks[s.key] = { label: s.label, args: s.args, result: payload(await client.callTool({ name: "ledger_check", arguments: s.args })) };

const audit = payload(await client.callTool({ name: "ledger_audit", arguments: {} }, undefined, LONG));
const issues = (audit.issues as Array<Record<string, unknown>> | undefined) ?? [];

// 豁免演示：对第一条做人工豁免，再审计一次
let waive: Record<string, unknown> | null = null;
let auditAfter: Record<string, unknown> | null = null;
if (issues[0]) {
  const first = issues[0] as { character?: string; propositionId?: unknown };
  waive = payload(
    await client.callTool({
      name: "ledger_waive",
      arguments: { character: String(first.character ?? ""), propositionId: String(first.propositionId ?? ""), reason: "演示：这是一条应当放过的事实" },
    }, undefined, LONG),
  );
  auditAfter = payload(await client.callTool({ name: "ledger_audit", arguments: {} }, undefined, LONG));
}

const page = issues[0]
  ? payload(await client.callTool({ name: "ledger_page", arguments: { propositionId: String((issues[0] as { propositionId?: unknown }).propositionId ?? "E-001") } }, undefined, LONG))
  : null;

await client.close();

const meta = JSON.parse(readFileSync(join(root, "eval", "baseline", "regression.json"), "utf8")) as Record<string, unknown>;

const out = {
  generatedAt: new Date().toISOString(),
  script: { name: "九章（演示剧本，23 场 / 2818 字）", scenes: ingest.scenes, propositions: ingest.propositions, aliases: ingest.aliases, knowledge: ingest.knowledge },
  ingest: { ms: ingestMs, result: ingest },
  checks,
  audit: { count: issues.length, issues },
  waive,
  auditAfter: auditAfter ? { count: ((auditAfter.issues as unknown[]) ?? []).length } : null,
  page,
  metrics: {
    judge: meta.judge,
    e2e: meta.e2e,
    real: meta.real,
  },
};

mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "data.json"), JSON.stringify(out, null, 2), "utf8");
console.log(`\n演示数据已写入 docs/data.json`);
console.log(`  建账 ${ingestMs}ms · 命题 ${String(ingest.propositions)} · 审计 ${issues.length} 条 · check 3 例`);

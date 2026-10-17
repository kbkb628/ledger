/**
 * 判定稳定性测试：同一条样本重复跑 K 次，量测判定的可复现性。
 *
 * 动机：JEV 实测发现同输入两次结果不同（test-log.md），而「审计工具必须可复现」
 * 是 design.md 的硬要求。本脚本用于横向比较各判定器的不确定性。
 *
 * 用法：
 *   npx tsx eval/stability.ts --provider openai --rounds 3
 *   $env:JUDGE_THINKING="disabled"; npx tsx eval/stability.ts --provider openai --rounds 5
 *   npx tsx eval/stability.ts --provider jev --rounds 3
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JevProvider } from "../src/judgment/jev-provider.js";
import { OpenAiCompatProvider } from "../src/judgment/openai-provider.js";
import { RuleProvider } from "../src/judgment/rule-provider.js";
import type { JudgmentProvider, JudgmentRequest, MentionKind } from "../src/judgment/types.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
loadEnv(join(here, "..", ".env"));

interface Prop {
  id: string;
  canonical: string;
  type: string;
  agent?: string;
  patient?: string;
  object?: string;
  time_ref?: string;
}
interface Sample {
  id: string;
  mention: { surface: string; scene: string; kind: MentionKind; context: string };
  candidates: string[];
  gold: string[];
}

const golden = JSON.parse(readFileSync(join(here, "goldenset.json"), "utf8")) as {
  propositions: Prop[];
  samples: Sample[];
};
const byId = new Map(golden.propositions.map((p) => [p.id, p]));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function pickProvider(name: string): JudgmentProvider {
  if (name === "rule") return new RuleProvider();
  if (name === "jev") return new JevProvider();
  if (name === "openai" || name === "deepseek") return new OpenAiCompatProvider();
  throw new Error(`未知 provider：${name}`);
}

function buildRequest(s: Sample): JudgmentRequest {
  return {
    task: "bind_mention",
    mention: s.mention,
    candidates: s.candidates.map((id) => {
      const p = byId.get(id);
      if (!p) throw new Error(`样本 ${s.id} 引用了不存在的命题 ${id}`);
      return {
        id: p.id,
        canonical: p.canonical,
        type: p.type,
        agent: p.agent,
        patient: p.patient,
        object: p.object,
        timeRef: p.time_ref,
      };
    }),
    allowedChoices: [...s.candidates, "NEW", "UNSURE"],
  };
}

const providerName = arg("provider", "rule");
const rounds = Math.max(2, Number(arg("rounds", "3")) || 3);
const provider = pickProvider(providerName);

console.log(`\n判定稳定性测试`);
console.log(`provider : ${provider.name}`);
console.log(`rounds   : ${rounds}   样本数: ${golden.samples.length}\n`);

interface Row {
  id: string;
  surface: string;
  gold: string[];
  choices: string[];
  confs: number[];
  stable: boolean;
  correctFirst: boolean;
}

const rows: Row[] = [];
let totalCalls = 0;
const started = Date.now();

for (const s of golden.samples) {
  const req = buildRequest(s);
  const choices: string[] = [];
  const confs: number[] = [];

  for (let i = 0; i < rounds; i += 1) {
    const r = await provider.judge(req);
    totalCalls += 1;
    choices.push(r.choice);
    confs.push(r.confidence);
  }

  const stable = choices.every((c) => c === choices[0]);
  const row: Row = {
    id: s.id,
    surface: s.mention.surface,
    gold: s.gold,
    choices,
    confs,
    stable,
    correctFirst: s.gold.includes(choices[0]!),
  };
  rows.push(row);
  process.stdout.write(`  ${s.id} ${stable ? "稳定" : "**不稳定**"}  ${choices.join(" / ")}\n`);
}

const stableCount = rows.filter((r) => r.stable).length;
const unstable = rows.filter((r) => !r.stable);

console.log(`\n${"─".repeat(56)}`);
console.log(`判定完全一致: ${stableCount}/${rows.length}  (${((stableCount / rows.length) * 100).toFixed(1)}%)`);

if (unstable.length > 0) {
  console.log(`\n不稳定的样本（同一输入，不同轮次给出不同答案）:`);
  for (const r of unstable) {
    const wrong = r.choices.filter((c) => !r.gold.includes(c));
    console.log(`  ${r.id} 「${r.surface}」  期望 ${r.gold.join("/")}`);
    console.log(`     ${r.choices.join("  →  ")}${wrong.length ? "   （其中含错误答案）" : ""}`);
  }
} else {
  console.log(`\n没有任何样本在不同轮次间改变答案。`);
}

// confidence 波动
const spreads = rows
  .map((r) => Math.max(...r.confs) - Math.min(...r.confs))
  .sort((a, b) => a - b);
const medianSpread = spreads[Math.floor(spreads.length / 2)] ?? 0;
const maxSpread = spreads[spreads.length - 1] ?? 0;
console.log(`\nconfidence 波动（极差，同一样本各轮之间）:`);
console.log(`  中位 ${medianSpread.toFixed(3)}   最大 ${maxSpread.toFixed(3)}`);

console.log(`\n总调用 ${totalCalls} 次，总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`${"─".repeat(56)}\n`);

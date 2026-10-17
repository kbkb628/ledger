/**
 * 打印 JEV 请求体但**不发送**——用于在花钱之前核对格式与 criteria 构造。
 *
 * 用法：
 *   npx tsx eval/jev-preview.ts            # 默认看 G-003
 *   npx tsx eval/jev-preview.ts G-016      # 看指定样本（最容易混淆的那条）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCriteria } from "../src/judgment/jev-provider.js";
import { BIND_MENTION_INSTRUCTIONS } from "../src/judgment/prompt.js";
import type { JudgmentRequest } from "../src/judgment/types.js";

const here = dirname(fileURLToPath(import.meta.url));

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
  mention: { surface: string; scene: string; kind: "explicit_noun" | "repeated_surface" | "vague_pronoun"; context: string };
  candidates: string[];
  gold: string[];
  note?: string;
}

const golden = JSON.parse(readFileSync(join(here, "goldenset.json"), "utf8")) as {
  propositions: Prop[];
  samples: Sample[];
};
const byId = new Map(golden.propositions.map((p) => [p.id, p]));

const wanted = process.argv[2] ?? "G-003";
const sample = golden.samples.find((s) => s.id === wanted);
if (!sample) {
  console.error(`找不到样本 ${wanted}。可用：${golden.samples.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const req: JudgmentRequest = {
  task: "bind_mention",
  mention: sample.mention,
  candidates: sample.candidates.map((id) => {
    const p = byId.get(id);
    if (!p) throw new Error(`样本 ${sample.id} 引用了不存在的命题 ${id}`);
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
  allowedChoices: [...sample.candidates, "NEW", "UNSURE"],
};

const body = {
  model: process.env.JEV_MODEL ?? "typesafe/jev-1.14",
  state: {
    mention: req.mention.surface,
    scene: req.mention.scene,
    mention_kind: req.mention.kind,
    context: req.mention.context,
  },
  questions: {
    bind: {
      type: "choice",
      instructions: BIND_MENTION_INSTRUCTIONS,
      criteria: buildCriteria(req),
    },
  },
};

console.log(`样本 ${sample.id}　期望：${sample.gold.join(" / ")}`);
if (sample.note) console.log(`备注：${sample.note}`);
console.log(`\nPOST https://openrouter.ai/api/alpha/decisions\n`);
console.log(JSON.stringify(body, null, 2));

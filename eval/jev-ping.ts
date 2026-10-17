/**
 * TypeSafe / JEV 连通性与请求体探针。
 * 依次尝试几种请求体变体，打印各自的状态码与响应体 —— 用于定位 422 之类的问题。
 *
 * 用法：npx tsx eval/jev-ping.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");

function readEnv(key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (m) return m[1]!.trim();
  }
  return undefined;
}

const apiKey = readEnv("JEV_API_KEY");
if (!apiKey) {
  console.error("缺少 JEV_API_KEY");
  process.exit(1);
}
const url = readEnv("JEV_BASE_URL") ?? "https://api.typesafe.ai/v1/systemone";

const noulQuestion = {
  type: "noul",
  instructions: "Is this request a connectivity test?",
  criteria: { true: "Yes, it is a test", false: "No, it is real work" },
};

const variants: Array<{ name: string; body: unknown }> = [
  {
    name: "① 无 model，state 为字符串",
    body: { state: "connectivity test", questions: { ok: noulQuestion } },
  },
  {
    name: "② model=jev-latest",
    body: { model: "jev-latest", state: "connectivity test", questions: { ok: noulQuestion } },
  },
  {
    name: "③ model=jev-1.13.0",
    body: { model: "jev-1.13.0", state: "connectivity test", questions: { ok: noulQuestion } },
  },
  {
    name: "④ state 为对象，无 model",
    body: { state: { note: "connectivity test" }, questions: { ok: noulQuestion } },
  },
];

console.log(`endpoint: ${url}`);
console.log(`key 长度: ${apiKey.length}，前缀: ${apiKey.slice(0, 8)}\n`);

for (const v of variants) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(v.body),
    });
    const text = await res.text();
    console.log(`${v.name}  →  HTTP ${res.status}`);
    console.log(`  ${text ? text.slice(0, 600) : "(空响应体)"}\n`);
  } catch (err) {
    console.log(`${v.name}  →  异常: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── choice 原语探针：核对 choice / confidence / probabilities 三者的关系 ──
// 用黄金集 G-008（「我父亲真正的遗嘱」，实测 margin 为负）复现。
const choiceRes = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: readEnv("JEV_MODEL") ?? "jev-latest",
    state: {
      mention: "我父亲真正的遗嘱",
      scene: "S11-01",
      mention_kind: "explicit_noun",
      context: "我父亲真正的遗嘱，在这里。",
    },
    questions: {
      bind: {
        type: "choice",
        instructions:
          "判断「待绑定说法」在这段上下文中指的是哪一条候选命题。不要把「主题相似」当作「同一命题」的证据。",
        criteria: {
          "F-002": "苏婉伪造并调换了沈父的遗嘱",
          "F-003": "沈父真正的遗嘱藏在怀表夹层里",
          "F-009": "陈默手上持有一份沈父的遗嘱文件",
          "F-010": "沈父三年前立过一份遗嘱",
          NEW: "上面任何一条都不是——这是一个新命题，应新建",
          UNSURE: "线索不足或互相冲突，无法判定，拒绝作答",
        },
      },
    },
  }),
});
console.log(`=== choice 原语完整响应（G-008 复现）HTTP ${choiceRes.status} ===`);
console.log(await choiceRes.text());

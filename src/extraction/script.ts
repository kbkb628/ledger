/**
 * 剧本解析 —— 抽取层的输入侧。
 *
 * 剧本格式（见 eval/script-jiuzhang.md）：
 *   ## S01-01
 *   - 时间锚：现在（重生点）· 地点：卧室 · 在场：沈知微
 *
 *   沈知微睁眼，盯着床头的日历。
 *   沈知微：（低声）三年前。我回来了。
 *
 * 只做**切场**，不解释内容 —— 语义一律交给抽取模型，代码不猜。
 */

export interface Scene {
  id: string;
  /** 场次元数据行（- 时间锚 / - 地点 / - 在场），原样保留 */
  meta: string[];
  /** 正文行（台词与叙述），原样保留、不改写 */
  lines: string[];
}

/** 按 `## <sceneId>` 切场，保持剧本自身顺序（即叙事顺序）。 */
export function parseScenes(markdown: string): Scene[] {
  const scenes: Scene[] = [];
  let current: Scene | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^##\s+(\S+)/.exec(line);
    if (head) {
      current = { id: head[1]!, meta: [], lines: [] };
      scenes.push(current);
      continue;
    }
    if (!current || !line || line === "---") continue;
    if (line.startsWith("- ")) current.meta.push(line.slice(2).trim());
    else current.lines.push(line);
  }

  return scenes;
}

/** 取某场的正文行；场景不存在时返回空数组。 */
export function linesOf(scenes: Scene[], sceneId: string): string[] {
  return scenes.find((s) => s.id === sceneId)?.lines ?? [];
}

/** 渲染成喂给抽取模型的文本（保留说话人前缀与换行）。 */
export function renderScene(scene: Scene): string {
  const meta = scene.meta.length ? `${scene.meta.join(" · ")}\n` : "";
  return `${meta}${scene.lines.join("\n")}`;
}

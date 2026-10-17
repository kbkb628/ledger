/**
 * 把 MCP server 打成**单文件** `dist/mcp.js`，让它在仓库之外也能跑。
 *
 * 为什么需要（P0-2）：`bin` 之前指向 `src/mcp/server.ts`，那是 tsx 才能解释的 TypeScript ——
 * `npx -y <pkg>` 装到一个空目录里根本没有 tsx，于是「挂到你自己的剧本 agent 上」这句
 * 话在包外不成立。产品的卖点需要一个能装的入口。
 *
 * 两个必须保留的东西：
 *  1. `#!/usr/bin/env node` —— esbuild 会保留入口文件的 hashbang；丢了 npm 的 shim 就起不来。
 *  2. ESM（`type: module`）—— 与仓库内一致，避免 CJS/ESM 双形态带来的 `__dirname` 差异。
 *
 * 用法：npm run build（`prepack` 会自动跑，所以 `npm pack` 一定带最新的 dist）
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await build({
  entryPoints: ["src/mcp/server.ts"],
  outfile: "dist/mcp.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // SDK 里可能有可选依赖的 require，留在外面由 npm 装；它本来就是 dependencies 里的一条
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

if (result.errors.length > 0) process.exitCode = 1;

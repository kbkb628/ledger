/**
 * 匈牙利算法（Kuhn–Munkres）最小代价最优指派。
 *
 * ## 为什么需要（一次方法论纠错）
 *
 * 我把「golden 命题 → 抽出命题」的匹配写成**一对一杯贪心**：按匹配强度降序，
 * 谁先抢到就锁死。当时是为了修「枢纽假命中」（一条抽出命题同时命中多条 golden，
 * 导致别名召回虚高），方向对，但用错了算法。
 *
 * 事件共指评测的标准做法是 **CEAF-e**：用匈牙利算法求**最优一对一指派**，
 * 而不是贪心。贪心的具体后果是——**先抢走的候选锁死后，另一条 gold 可能再无匹配，
 * recall 系统性偏低**。也就是说我此前所有基于贪心匹配的召回率都偏低。
 *
 * ## 实现
 *
 * 经典 O(n³) 匈牙利（e-maxx 版本），对 n ≤ 200 足够。
 * 输入代价矩阵要求 `rows ≤ cols`；不满足时自动转置。
 * 返回 `assignment[r] = c`，未指派的行为 -1。
 */
export function hungarianMin(cost: number[][]): { assignment: number[]; total: number } {
  const n0 = cost.length;
  if (n0 === 0) return { assignment: [], total: 0 };
  const m0 = cost[0]!.length;

  // 行数必须 ≤ 列数；否则转置后求解再映射回来
  const transposed = n0 > m0;
  const a = transposed ? transpose(cost) : cost.map((r) => [...r]);
  const n = a.length;
  const m = a[0]!.length;

  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  // p[j] = 分配到列 j 的行（1-based）；0 表示未分配
  const rowToCol = new Array<number>(n).fill(-1);
  let total = 0;
  for (let j = 1; j <= m; j++) {
    const i = p[j]!;
    if (i > 0) {
      rowToCol[i - 1] = j - 1;
      total += a[i - 1]![j - 1]!;
    }
  }

  if (!transposed) return { assignment: rowToCol, total };

  // 转置情形：原矩阵 rowToCol 的语义反过来
  const out = new Array<number>(m0).fill(-1);
  for (let r = 0; r < n; r++) {
    const c = rowToCol[r]!;
    if (c >= 0) out[c] = r;
  }
  return { assignment: out, total };
}

function transpose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0]!.length;
  const t: number[][] = Array.from({ length: cols }, () => new Array<number>(rows).fill(0));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) t[c]![r] = m[r]![c]!;
  return t;
}

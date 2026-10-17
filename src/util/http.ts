/**
 * 带超时的 fetch —— 全项目统一入口。
 *
 * ## 为什么必须加（一次真实事故）
 *
 * 联合回归跑到一半卡了 **30 分钟没有任何输出**，进程 CPU 接近 0：
 * 抽取请求挂在网络上，而所有 `fetch` 都没有超时，于是**永久等待**。
 *
 * 这类卡死比报错更危险：报错会停下并留痕，卡死只是让整条流水线静默停住，
 * 而且要人肉去看进程才发得现。
 *
 * ## 默认值
 *
 * `HTTP_TIMEOUT_MS`（默认 120000）。抽取单场典型 5–35 秒，判 0.2 秒，
 * 两分钟足够覆盖慢请求，又不至于让一次偶发挂起拖死整轮回归。
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export function httpTimeoutMs(): number {
  const v = Number(process.env.HTTP_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * @param label 出错时用来定位是哪一步（"抽取 S03-05" / "JEV 判定" / …）
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = httpTimeoutMs(),
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s 无响应）：${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

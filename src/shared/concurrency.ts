/**
 * **并发闸门（信号量）**：最多 `limit` 个任务同时在飞。
 *
 * ## 为什么需要它（实测的账）
 *
 * 语义判定是"12 条一批 × 3 票 × N 批"的**互相独立**的调用，而它们原来是**串行**跑的：
 * 长会话（83 条待判）实测每批墙钟 **15–22 秒**（2026-10-14 宿主日志：13:58:57、13:59:19、
 * 13:59:34…），一场两分钟起。同一个会话里这些调用之间没有依赖，串行只是"最省事的写法"。
 *
 * ## 为什么是"叶子层闸门"，不是"给批/票各加一层 mapLimit"
 *
 * 两层各自限流会把并发**乘起来**（3 批 × 3 票 = 9 个在飞，实测过一次）；
 * 而"外层持有名额、内层等名额"的写法会**死锁**。所以闸门只放在**真正发起模型调用**
 * 的那一层：总在飞数恒不超过 `limit`，谁先到谁先占，批次与票只用 `Promise.all` 铺开。
 *
 * `limit ≤ 1` 时退化成串行（与改造前完全一致，可用来对照）。
 */
export function createLimiter(limit: number): <R>(run: () => Promise<R>) => Promise<R> {
  const size = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1))
  let active = 0
  const waiting: (() => void)[] = []
  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next !== undefined) next()
  }
  return async function limited<R>(run: () => Promise<R>): Promise<R> {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await run()
    } finally {
      release()
    }
  }
}

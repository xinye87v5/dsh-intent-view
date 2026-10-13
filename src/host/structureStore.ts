/**
 * **结构缓存的落盘**。
 *
 * ## 为什么要有它
 *
 * `taskStructureUnit.ts` 的 `cache` 是"内容没变就不再问模型"的地基，但它只在
 * **进程内存**里：宿主一重启就清零，于是重启后第一次打开任意会话都要**全量重算**
 * （1 建 + N 批 + 1 整理 + 0/1 裁定；377 回合那场实测 33 次调用 / 41.7 秒）。
 * 语义判定那条路已经落了盘（`semanticTurnStore.ts`），结构这条一直是漏的。
 *
 * ## 契约（与 `semanticTurnStore` 一字不差地同一套）
 *
 * - **形状版本不同就当空**：文件里存 `version`，一变整份丢弃——旧流水线形状的结论
 *   被当成新形状用，会造出"面板画得出、判定读不懂"的结构；
 * - **坏文件当空**（不抛）：手改坏、写一半断电、磁盘满，都只该退化成"没有缓存"；
 * - **写入尽力而为**：失败只返回 false，绝不让缓存写失败影响请求；
 * - **上限**：最多 `max` 条（按插入顺序丢最旧的）。
 *
 * 路径默认 `~/.dsh/storages/intent-view/structures.json`，
 * 可用 `DSH_INTENT_STRUCTURE_CACHE=<文件>` 覆盖（测试与多实例都用它）。
 *
 * ⚠️ 与 `semanticTurnStore.ts` 同一条纪律：**不 import `node:*` 的类型**
 * （本插件刻意不依赖 `@types/node`），用变量说明符动态取模块。
 */
interface FsLike {
  readFileSync: (file: string, encoding: string) => string
  writeFileSync: (file: string, data: string) => void
  mkdirSync: (dir: string, options: { recursive: boolean }) => void
}
interface PathLike {
  dirname: (file: string) => string
  join: (...parts: string[]) => string
}
interface OsLike {
  homedir: () => string
}

/**
 * ⚠️ **不能在模块顶层 `await import`**（`semanticTurnStore.ts` 那样）：顶层 await 会让
 * 整个模块图变成 async，而 `verify-task-structure.cjs` 是用 `require()` 载入
 * `taskStructureUnit.js` 的——Node 的 require(esm) 遇到 async 图直接抛
 * `ERR_REQUIRE_ASYNC_MODULE`（实测把整条 build 打断）。所以这里把取模块推迟到**函数内**，
 * 两个入口都是 async 的。
 */
async function nodeModules(): Promise<{ fs: FsLike; path: PathLike; os: OsLike }> {
  const fsSpec = 'node:fs'
  const pathSpec = 'node:path'
  const osSpec = 'node:os'
  return {
    fs: (await import(fsSpec)) as unknown as FsLike,
    path: (await import(pathSpec)) as unknown as PathLike,
    os: (await import(osSpec)) as unknown as OsLike,
  }
}

/**
 * 缓存文件的形状版本。
 *
 * **改流水线输出的形状时（含 `stateVersion`）必须 +1**：这份文件里存的是
 * 整棵结构（nodes/membership/roots/meta），形状一变，旧的那份就是"读得出来但不对"。
 * 与 `SEMANTIC_JUDGE_VERSION` 是同一个道理，只是这里管的是结构而不是判定。
 */
export const STRUCTURE_CACHE_VERSION = 1

/** 一条结构缓存项：键 + 结论（形状由调用方给，这里只当中转）。 */
export interface StoredStructure {
  [key: string]: unknown
}

export function structureStorePathSync(home: string, join: (...parts: string[]) => string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const override = env?.DSH_INTENT_STRUCTURE_CACHE
  if (typeof override === 'string' && override !== '') return override
  return join(home, '.dsh', 'storages', 'intent-view', 'structures.json')
}

/** 缓存开关：`DSH_INTENT_STRUCTURE_NOCACHE` 一开就**既不读也不写**（测试与排查用）。 */
export function structureCacheDisabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const flag = env?.DSH_INTENT_STRUCTURE_NOCACHE
  return flag === '1' || flag === 'true'
}

/**
 * 读结构缓存。**任何异常都退化成空**——缓存坏了不该让功能坏。
 *
 * @param version - 当前形状版本；文件里的版本不同就整份丢弃。
 */
export async function loadStructureCache<T>(version: number, file?: string): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  if (structureCacheDisabled()) return out
  const { fs, path, os } = await nodeModules()
  const target = file ?? structureStorePathSync(os.homedir(), path.join)
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { version?: unknown; entries?: unknown }
    if (Number(parsed?.version) !== version) return out
    const entries = parsed?.entries
    if (!Array.isArray(entries)) return out
    for (const item of entries) {
      if (!Array.isArray(item) || item.length !== 2) continue
      const [key, value] = item as [unknown, T]
      if (typeof key !== 'string' || value === undefined || value === null) continue
      out.set(key, value)
    }
  } catch {
    // 文件不存在 / 坏 JSON / 读不了：就是"没有缓存"
  }
  return out
}

/** 写结构缓存。**尽力而为**：失败只返回 false，不抛。 */
export async function saveStructureCache<T>(
  cache: Map<string, T>,
  version: number,
  max: number,
  file?: string,
): Promise<boolean> {
  if (structureCacheDisabled()) return false
  const { fs, path, os } = await nodeModules()
  const target = file ?? structureStorePathSync(os.homedir(), path.join)
  try {
    const entries = [...cache.entries()].slice(-max)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ version, at: Date.now(), entries }))
    return true
  } catch {
    return false
  }
}

/**
 * **缓存淘汰**（B7）：`saveStructureCache` 原先只做 `slice(-max)`（按**插入顺序**丢最旧的），
 * 有两个实际问题：
 *
 * 1. **一个话多的会话能挤掉所有别的会话**：键是 `sessionId::contentHash::…`，
 *    内容一变就多一条，一次会话能占几十条；
 * 2. **热点键不会被"用热"**：`Map.set` 一个已存在的键**不会**把它移到末尾
 *    ⇒ 频繁命中的那个会话仍停在老位置，先被丢掉。
 *
 * 所以淘汰按两条规则（纯函数，可断言）：
 * - **每个会话只留最新一条**（旧 contentHash 的那条没有任何价值：面板永远用当前内容问；
 *   `memo` 也只在进程内记最近一次）；
 * - 其余按**最近使用**保留（调用方在命中/写入时把键重新 `set` 一遍即可——`Map` 的
 *   插入序就变成了使用序，这是 Map 当 LRU 的经典用法，不用额外存时间戳）。
 *
 * @param cache - 调用方维护的 Map（其**插入顺序 = 使用顺序**）
 * @param keepPerSession - 每个会话保留几条（默认 1）
 * @param maxTotal - 总量上限（默认 300）
 * @param sessionOf - 从键里取 sessionId（默认按 `::` 切第一段）
 */
export function pruneStructureCache<T>(
  cache: Map<string, T>,
  { keepPerSession = 1, maxTotal = 300, sessionOf = (key: string) => key.split('::')[0] } = {},
): Map<string, T> {
  const seen = new Map<string, number>()
  const kept: [string, T][] = []
  // 从**最新**往回收：每个会话先收到的就是它最新的那条
  const entries = [...cache.entries()]
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, value] = entries[i]
    const session = sessionOf(key)
    const count = seen.get(session) ?? 0
    if (count >= keepPerSession) continue
    seen.set(session, count + 1)
    kept.push([key, value])
    if (kept.length >= maxTotal) break
  }
  // 恢复成"旧 → 新"的顺序，调用方那边的插入序语义不变
  return new Map(kept.reverse())
}

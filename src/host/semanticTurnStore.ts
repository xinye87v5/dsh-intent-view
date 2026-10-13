/**
 * **逐回合判定的落盘缓存**。
 *
 * ## 为什么要有它
 *
 * 逐回合缓存（`host/semanticUnit.ts` 的 `turnCache`）是"新增回合只判变的那几条"的地基，
 * 但它原先只在**进程内存**里：宿主一重启就清零，于是重启后第一次打开面板会把整场重判一遍
 * （实测一场 377 回合的要 100+ 秒、上百次调用）。这一步把它落到磁盘。
 *
 * ## 契约（都是踩过坑之后写死的）
 *
 * - **判据版本不同就当空**：键里本来就带 `SEMANTIC_JUDGE_VERSION`，但文件里还存一份
 *   `version` 字段——版本一变整份丢弃，免得旧判据的结论被当成新判据的；
 * - **坏文件当空**（不抛）：用户手改坏、写到一半断电、磁盘满，都只该"退化成没有缓存"；
 * - **写入尽力而为**：存不下就继续用内存那份，绝不因为缓存写失败而让判定失败；
 * - **上限**：文件里最多 `max` 条（按插入顺序丢最旧的），免得无限长。
 *
 * 路径默认 `~/.dsh/storages/intent-view/semantic-turns.json`，可用
 * `DSH_INTENT_SEMANTIC_CACHE=<文件>` 覆盖（测试与多实例都用它）。
 */
/**
 * ⚠️ **不 import `node:*` 的类型**：本插件刻意不依赖 `@types/node`
 * （宿主半边别的文件也一样，环境的取法都用 `globalThis.process`）。
 * 所以这里用**变量说明符**动态取模块——TS 解析不了它就按 `any` 处理，
 * 而那三个函数的形状由下面的 `FsLike` / `PathLike` / `OsLike` 自己声明。
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

const fsSpec = 'node:fs'
const pathSpec = 'node:path'
const osSpec = 'node:os'
const fs = (await import(fsSpec)) as unknown as FsLike
const path = (await import(pathSpec)) as unknown as PathLike
const os = (await import(osSpec)) as unknown as OsLike

/** 一条判定的形状（与 `VotedVerdict` 兼容，这里不 import 免得把 shared 拖进宿主启动路径）。 */
export interface StoredVerdict {
  turn: number
  match: boolean
  reason: string
  votes?: number
  total?: number
  want?: string
  got?: string
  touched?: string[]
  understanding?: boolean
  inScope?: boolean
}

export function turnStorePath(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const override = env?.DSH_INTENT_SEMANTIC_CACHE
  if (typeof override === 'string' && override !== '') return override
  return path.join(os.homedir(), '.dsh', 'storages', 'intent-view', 'semantic-turns.json')
}

/**
 * 读缓存。**任何异常都退化成空**——缓存坏了不该让功能坏。
 *
 * @param version - 当前判据版本；文件里的版本不同就整份丢弃。
 */
export function loadTurnCache(version: number, file = turnStorePath()): Map<string, StoredVerdict> {
  const out = new Map<string, StoredVerdict>()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: unknown
      entries?: unknown
    }
    if (Number(parsed?.version) !== version) return out
    const entries = parsed?.entries
    if (!Array.isArray(entries)) return out
    for (const item of entries) {
      if (!Array.isArray(item) || item.length !== 2) continue
      const [key, verdict] = item as [unknown, StoredVerdict]
      if (typeof key !== 'string' || typeof verdict?.turn !== 'number') continue
      out.set(key, verdict)
    }
  } catch {
    // 文件不存在 / 坏 JSON / 读不了：就是"没有缓存"
  }
  return out
}

/** 写缓存。**尽力而为**：失败只返回 false，不抛。 */
export function saveTurnCache(
  cache: Map<string, StoredVerdict>,
  version: number,
  max: number,
  file = turnStorePath(),
): boolean {
  try {
    const entries = [...cache.entries()].slice(-max)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version, at: Date.now(), entries }))
    return true
  } catch {
    return false
  }
}

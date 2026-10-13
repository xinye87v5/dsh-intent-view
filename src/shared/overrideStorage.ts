/**
 * 人工调整的**浏览器侧存储**（localStorage）。
 *
 * ## 为什么落在浏览器（使用者裁定 2026-10-10：B3 同意）
 *
 * 三个候选里选了它：
 *
 * - 宿主侧写 `~/.dsh/...` 需要 `@types/node`，而 `tsconfig` 没有、且 `src/index.ts`
 *   明写"本插件不碰文件系统"；
 * - 框架的存储服务没找到官方入口；
 * - **改的人本来就在浏览器里**，localStorage 零宿主风险、立刻跨刷新存活。
 *
 * 代价说清楚：**换浏览器/换机器不带过去**。真要跨端，再把宿主侧那份接上
 * （路由 `POST /api/intent.overrides` 已经在了，就等一个持久的家）。
 *
 * ## 注入 `storage`
 *
 * `localStorage` 在 Node 里不存在，所以这一层只依赖一个 `StorageLike` 形状
 * （`getItem`/`setItem`/`removeItem`）。于是它能被
 * `scripts/verify-override-storage.cjs` **离线**测（配额满、坏 JSON、跨会话串味）。
 */
import { sessionKey, validateOverrides, type TaskOverride } from './taskOverrides.js'

/** 只用到这三个方法，宿主/测试都好替身。 */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** 存储键。带命名空间与版本，免得以后改形状时读到旧数据还以为坏了。 */
export const OVERRIDES_KEY_PREFIX = 'dsh-intent-view:overrides:v1:'

export function overridesStorageKey(sessionId: string): string | null {
  const key = sessionKey(sessionId)
  return key === null ? null : `${OVERRIDES_KEY_PREFIX}${key}`
}

/**
 * 读某会话的人工调整。
 *
 * **坏数据不炸**：键不存在、JSON 坏了、形状不对，一律当"没有人工调整"。
 * 面板宁可少显示一层信息，也不该因为一条坏记录整块打不开。
 */
export function loadOverrides(storage: StorageLike, sessionId: string): TaskOverride[] {
  const key = overridesStorageKey(sessionId)
  if (key === null) return []
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return []
  }
  if (raw === null || raw === '') return []
  try {
    const { list } = validateOverrides(JSON.parse(raw))
    return list === null ? [] : normalizeOverrides(list)
  } catch {
    return []
  }
}

/**
 * **同一回合堆了多条 `setPlacement` 时只留最后一条**。
 *
 * 写入侧本来就只留一条（`withPlacement` 先滤再追加），所以这只会出现在
 * **手改过 localStorage**、或旧版本残留的情况下。选择"归并"而不是"拒收"：
 * `validateOverrides` 返回 null 时调用方拿到的是**空列表**——那是把用户所有改动
 * 一次抹掉，比多一条记录危险得多。回放顺序决定结果，所以留**最后**一条（与写入侧一致）。
 */
export function normalizeOverrides(list: readonly TaskOverride[]): TaskOverride[] {
  const lastPlacement = new Map<number, number>()
  list.forEach((item, index) => {
    if (item.op === 'setPlacement') lastPlacement.set(item.turn, index)
  })
  return list.filter((item, index) => item.op !== 'setPlacement' || lastPlacement.get(item.turn) === index)
}

/**
 * 写。**失败要返回原因而不是抛**：配额满（QuotaExceededError）、隐私模式禁用
 * localStorage，都是现实里会遇到的情况，面板该照常显示、只是提示"没能保存"。
 */
export function saveOverrides(
  storage: StorageLike,
  sessionId: string,
  overrides: TaskOverride[],
): { ok: boolean; error?: string } {
  const key = overridesStorageKey(sessionId)
  if (key === null) return { ok: false, error: 'sessionId 非法' }
  const { list, problems } = validateOverrides(overrides)
  if (list === null) return { ok: false, error: `形状不合法：${problems[0]}` }
  try {
    storage.setItem(key, JSON.stringify(list))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 撤销全部人工调整（只清这一个会话的键）。 */
export function clearOverrides(storage: StorageLike, sessionId: string): { ok: boolean; error?: string } {
  const key = overridesStorageKey(sessionId)
  if (key === null) return { ok: false, error: 'sessionId 非法' }
  try {
    storage.removeItem(key)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * **把"指向已消失节点"的落点按标题接回当前结构**（纯函数，A2）。
 *
 * ## 为什么需要它
 *
 * 结构是按会话内容重算的（压缩、整理、合并都会换掉一批 id），而人工覆盖存的是
 * **当时的 id**。于是使用者那个会话攒了 14 条改动、其中 4 条变成
 * `没有这个节点：t22`——**静默失效**，看起来就是"点了没反应"。
 *
 * ## v1 的边界（刻意收窄，宁少不错）
 *
 * - **只重接 `setPlacement` 的落点**：`delete`/`rename`/`reparent`/`create`/`merge`
 *   都是结构性意图，按标题猜目标风险更大（删错枝是真损失）；
 * - 旧标题到新节点**必须唯一**：找不到（标题也改了）或找到多个（同名并存）一律**不接**，
 *   让它继续留在"失效"清单里（面板已能列出并一键清理）；
 * - 活着的 id 一个都不动。
 *
 * ⚠️ 放在**本模块**（而不是 `taskOverrides.ts`）是打包器的约束：客户端
 * `wrap-client.mjs` 只认 `export function/const/let`，既不支持 `export { … } from`，
 * 也不许相对模块起别名。实现只有这一份。
 *
 * @param overrides - 存下来的覆盖列表
 * @param titles - **旧 id → 旧标题**（来自上一版结构；调用方负责提供）
 * @param nodes - 当前结构的节点表（id → 节点）
 */
export function remapOverridesByTitle(
  overrides: readonly TaskOverride[],
  titles: ReadonlyMap<string, string>,
  nodes: Record<string, { title?: string } | undefined>,
): { list: TaskOverride[]; remapped: { from: string; to: string; title: string }[] } {
  const byTitle = new Map<string, string[]>()
  for (const [id, node] of Object.entries(nodes)) {
    const title = String(node?.title ?? '').trim()
    if (title === '') continue
    byTitle.set(title, [...(byTitle.get(title) ?? []), id])
  }
  const remapped: { from: string; to: string; title: string }[] = []
  const resolve = (id: string): string => {
    if (nodes[id] !== undefined) return id
    const title = String(titles.get(id) ?? '').trim()
    if (title === '') return id
    const hits = byTitle.get(title) ?? []
    if (hits.length !== 1) return id
    remapped.push({ from: id, to: hits[0], title })
    return hits[0]
  }
  const list = overrides.map((item) => {
    if (item.op !== 'setPlacement') return item
    const next = [...new Set(item.nodes.map(resolve))]
    return next.length === item.nodes.length && next.every((id, i) => id === item.nodes[i])
      ? item
      : { ...item, nodes: next }
  })
  return { list, remapped }
}

/** 重接的账（写进面板诊断行，让人能核）——`''` = 没有可说的。 */
export function remapReceipt(remapped: readonly { from: string; to: string; title: string }[]): string {
  if (remapped.length === 0) return ''
  const shown = remapped.slice(0, 3).map((item) => `${item.from} → ${item.to}「${item.title}」`)
  const rest = remapped.length - shown.length
  return `按标题接回 ${remapped.length} 条旧改动（${shown.join('、')}${rest > 0 ? ` 等 ${rest} 条` : ''}）`
}

/** 这个开关默认开；`DSH_INTENT_REMAP_BY_TITLE=0/false/off` 关掉（一键回退）。 */
export function remapEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const flag = env?.DSH_INTENT_REMAP_BY_TITLE
  if (flag === undefined || flag === '') return true
  return !(flag === '0' || flag === 'false' || flag === 'off')
}

/**
 * **会话名的人工覆盖**（A3）。
 *
 * ## 为什么不能"把根当普通节点改名"
 *
 * 查过真实载荷：结构里**没有 `root` 这个节点**（`~/.dsh/storages/intent-view/structures.json`
 * 里那条是 19 个节点、无 `root`），根只是 `membership` 与 `parents` 里的一个约定。
 * 于是 `{op:'rename', id:'root'}` 会被校验层拒掉（"没有这个节点：root"）——
 * 那条路走不通，所以这里用**独立的键**存一个字符串覆盖。
 *
 * 与结构覆盖分开存：它的生命周期完全不同（结构重算不影响它，它也不进 `membership`）。
 */
export const SESSION_TITLE_KEY_PREFIX = 'dsh-intent-view:session-title:v1:'

export function sessionTitleStorageKey(sessionId: string): string | null {
  const key = sessionKey(sessionId)
  return key === null ? null : `${SESSION_TITLE_KEY_PREFIX}${key}`
}

/** 读会话名覆盖（坏数据/没有都当没有）。 */
export function loadSessionTitle(storage: StorageLike | undefined, sessionId: string): string | undefined {
  const key = sessionTitleStorageKey(sessionId)
  if (key === null || storage === undefined) return undefined
  try {
    const raw = storage.getItem(key)
    if (raw === null || raw === '') return undefined
    const parsed = JSON.parse(raw) as { title?: unknown }
    const title = typeof parsed?.title === 'string' ? parsed.title.trim() : ''
    return title === '' ? undefined : title.slice(0, 60)
  } catch {
    return undefined
  }
}

/** 写会话名覆盖；空串 = 撤掉覆盖（回到原来的名字）。 */
export function saveSessionTitle(
  storage: StorageLike | undefined,
  sessionId: string,
  title: string,
): { ok: boolean; error?: string } {
  const key = sessionTitleStorageKey(sessionId)
  if (key === null) return { ok: false, error: 'sessionId 非法' }
  try {
    if (title.trim() === '') storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify({ title: title.trim().slice(0, 60) }))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 生效的会话名 = 人工覆盖优先，否则用投影给的那个。 */
export function applySessionTitle(base: string, override: string | undefined): string {
  const wanted = String(override ?? '').trim()
  return wanted === '' ? base : wanted
}

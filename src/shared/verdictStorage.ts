/**
 * **人工修正判定标记**的浏览器侧存储（localStorage）。
 *
 * ## 为什么需要它
 *
 * 使用者裁定：*"这里我任务标记应该是可调整的，人工修正模型的自动判定结果"*。
 * 那条判据（理解 + 越界两问）实测在 32 条人工真值样例上精确率/召回率都是 100%，
 * 但那仍然是**模型的判断**；总有它判错、而人一眼能看出对错的时候。
 * 所以标记要能被人**盖掉**——盖掉的是显示与计数，不动模型那份原始结论。
 *
 * ## 与"结构覆盖"分开存
 *
 * 两者的键、生命周期、失效条件都不同：结构覆盖改的是图（id/父子/落点），
 * 判定覆盖只针对**某一个回合的结论**。混在一个键里，任何一边改形状都会连累另一边。
 *
 * ## 注入 `storage`（与 `overrideStorage.ts` 同一套做法）
 *
 * `localStorage` 在 Node 里不存在，所以只依赖 `StorageLike` 形状，于是能离线测
 * （坏 JSON、跨会话串味、配额满）。
 */
import { sessionKey } from './taskOverrides.js'

/** 只用到这三个方法，宿主/测试都好替身。 */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * 一条人工判定：只记"人对这一回合的结论"，三个字段各自可缺省。
 *
 * - `match`：人给的最终判定（`false` = 偏离）**覆盖**模型的两问合取；
 * - `understanding` / `inScope`：人若要区分"理解偏"还是"越界"，可以分别给；
 * - `note`：一句话备注（例如"这条我看过，模型理解错了"）。
 */
export interface VerdictOverride {
  turn: number
  /**
   * **两问（理解/越界）的人工结论**。可以缺省——第三问单独改时不该顺手写它。
   *
   * ⚠️ 这里原来必填，于是"只调父枝"必须编一个 `match` 出来（代码里写的 `?? true`），
   * 结果：一个**没判过**的回合被人调了父枝之后，标记从 `未判` 变成 `✓·人`
   * ——**人替模型认了一个它没做过的判断**。使用者 2026-10-10：
   * *"人工判定和父枝的调整，好像会冲突造成选项默认化"*。
   */
  match?: boolean
  understanding?: boolean
  inScope?: boolean
  /**
   * **第三问（归属贴近度）的人工修正**：`near` / `far` / `na`。
   *
   * 与 `match` 分开存也分开用（使用者裁定"结论分开"）：人可以把
   * "agent 做得对、但挂错了枝"这条两问结论原样留着，只改第三问。
   */
  parent?: 'near' | 'far' | 'na'
  note?: string
}

export const VERDICTS_KEY_PREFIX = 'dsh-intent-view:verdicts:v1:'

export function verdictsStorageKey(sessionId: string): string | null {
  const key = sessionKey(sessionId)
  return key === null ? null : `${VERDICTS_KEY_PREFIX}${key}`
}

/** 形状校验：坏数据一律丢掉（**不抛**——存储坏了不该让面板坏）。 */
function sanitize(raw: unknown): VerdictOverride[] {
  if (!Array.isArray(raw)) return []
  const out: VerdictOverride[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const turn = Number(row.turn)
    if (!Number.isInteger(turn) || turn < 1) continue
    // 至少要有一样结论（两问之一或第三问），否则这条没有意义
    const hasParent = row.parent === 'near' || row.parent === 'far' || row.parent === 'na'
    if (typeof row.match !== 'boolean' && !hasParent) continue
    out.push({
      turn,
      ...(typeof row.match === 'boolean' ? { match: row.match } : {}),
      ...(typeof row.understanding === 'boolean' ? { understanding: row.understanding } : {}),
      ...(typeof row.inScope === 'boolean' ? { inScope: row.inScope } : {}),
      ...(row.parent === 'near' || row.parent === 'far' || row.parent === 'na' ? { parent: row.parent } : {}),
      ...(typeof row.note === 'string' && row.note !== '' ? { note: row.note.slice(0, 200) } : {}),
    })
  }
  // 同一回合只留最后一条（人改两次不该堆两条，否则回放顺序决定结果）
  const last = new Map<number, VerdictOverride>()
  for (const item of out) last.set(item.turn, item)
  return [...last.values()].sort((left, right) => left.turn - right.turn)
}

/** 读某会话的人工判定。坏数据/没有都是空数组。 */
export function loadVerdictOverrides(storage: StorageLike | undefined, sessionId: string): VerdictOverride[] {
  const key = verdictsStorageKey(sessionId)
  if (key === null) return []
  try {
    const raw = storage?.getItem(key)
    if (raw === null || raw === undefined) return []
    return sanitize(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 写某会话的人工判定；返回失败原因（配额满等），**不抛**。 */
export function saveVerdictOverrides(
  storage: StorageLike | undefined,
  sessionId: string,
  overrides: readonly VerdictOverride[],
): { ok: true } | { ok: false; reason: string } {
  const key = verdictsStorageKey(sessionId)
  if (key === null) return { ok: false, reason: '会话 id 不合法，拒绝写入' }
  try {
    const clean = sanitize([...overrides])
    if (clean.length === 0) {
      storage?.removeItem(key)
      return { ok: true }
    }
    storage?.setItem(key, JSON.stringify(clean))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error).slice(0, 120) }
  }
}

/**
 * 把人工判定**叠到**模型结论上：人给的赢。
 *
 * 这是唯一一处"谁覆盖谁"的规则，写在共享层，宿主/浏览器/测试共用。
 */
export function applyVerdictOverrides<
  T extends { turn: number; match: boolean; understanding?: boolean; inScope?: boolean; parent?: 'near' | 'far' | 'na' },
>(
  verdicts: readonly T[],
  overrides: readonly VerdictOverride[],
): (T & { human?: boolean; note?: string })[] {
  if (overrides.length === 0) return [...verdicts]
  const byTurn = new Map(overrides.map((item) => [item.turn, item]))
  const out = verdicts.map((verdict) => {
    const human = byTurn.get(verdict.turn)
    if (human === undefined) return verdict
    /**
     * **只覆盖人真给过的字段**：`match` 缺省就保持模型结论。
     * `human`（标记上的 `·人`）只在两问被人改过时置位；第三问单独有 `humanParent`。
     */
    const touchedTwo = human.match !== undefined || human.understanding !== undefined || human.inScope !== undefined
    return {
      ...verdict,
      ...(human.match !== undefined ? { match: human.match } : {}),
      ...(human.understanding !== undefined ? { understanding: human.understanding } : {}),
      ...(human.inScope !== undefined ? { inScope: human.inScope } : {}),
      ...(human.parent !== undefined ? { parent: human.parent } : {}),
      ...(touchedTwo ? { human: true } : {}),
      ...(human.parent !== undefined ? { humanParent: true } : {}),
      ...(human.note !== undefined ? { note: human.note } : {}),
    }
  })
  // 人标了、但模型这一场没判过的回合也要露出来（否则"我标的那条去哪了"）
  const known = new Set(verdicts.map((v) => v.turn))
  for (const human of overrides) {
    if (known.has(human.turn)) continue
    // 只有第三问、没有两问结论 ⇒ 不该冒出一个 match（那会凭空把回合标成"正常"）
    if (human.match === undefined && human.understanding === undefined && human.inScope === undefined) continue
    out.push({
      turn: human.turn,
      match: human.match ?? true,
      reason: human.note ?? '人工判定（模型这一场没有判过这个回合）',
      human: true,
      ...(human.understanding !== undefined ? { understanding: human.understanding } : {}),
      ...(human.inScope !== undefined ? { inScope: human.inScope } : {}),
      ...(human.parent !== undefined ? { parent: human.parent } : {}),
    } as unknown as T & { human?: boolean; note?: string })
  }
  return out.sort((left, right) => left.turn - right.turn)
}

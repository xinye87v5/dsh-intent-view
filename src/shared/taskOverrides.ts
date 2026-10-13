/**
 * 人工调整的**形状校验与键规范**：纯函数，宿主与浏览器**共用同一份**。
 *
 * 为什么放在 shared 而不是 host：两侧都需要它——宿主校验 HTTP 请求体，
 * 浏览器在写入 localStorage 之前也要校验。两份实现必然会漂移
 * （本项目已经在 `splitlines` vs `split('\n')` 上吃过一次）。
 *
 * 界线要记住：这里只管**形状**（op 认识、字段类型对、回合号是正整数）。
 * **语义对错交给人**（使用者裁定 2026-10-10：给手动调整的入口，而不是再写判据逼近）；
 * 真应用时会由 `taskGraph.ts` 的 `applyOverrides` 按**当时的图**再校验一次。
 */

/** 一步人工调整。与流水线里验证过的 ops 词汇表一致。 */
export type TaskOverride =
  | { op: 'setPlacement'; turn: number; nodes: string[] }
  | { op: 'rename'; id: string; title: string }
  | { op: 'merge'; from: string[]; into: string; title?: string }
  | { op: 'create'; id: string; title: string; parents: string[] }
  | { op: 'delete'; id: string }
  /**
   * **挂枝**：整份替换某个节点的父集合（多父 = 一个节点挂到几个枝上）。
   *
   * 使用者裁定："一个节点可以被挂到几个枝上了，还要考虑一下"。
   * `parents: []` = 把它变成**独立节点**（与项目线并列），这也是有效的人工决定。
   */
  | { op: 'reparent'; id: string; parents: string[] }

export const OVERRIDE_OPS = ['setPlacement', 'rename', 'merge', 'create', 'delete', 'reparent'] as const

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * 会话 id → 安全键。
 *
 * **必须挡住路径穿越**：会话 id 来自 HTTP 请求体、也来自 localStorage 的键。
 * 就算后端是内存的，也不该放任 `../..` 流进去（哪天换成文件/对象存储就是漏洞）。
 */
export function sessionKey(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string') return null
  const id = sessionId.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null
  if (id === '.' || id === '..') return null
  return id
}

/** 校验 `overrides` 的形状，逐条报出问题。 */
export function validateOverrides(value: unknown): { list: TaskOverride[] | null; problems: string[] } {
  if (value === undefined) return { list: [], problems: [] }
  if (!Array.isArray(value)) return { list: null, problems: ['overrides 必须是数组'] }
  if (value.length > 500) return { list: null, problems: [`一次最多 500 条（收到 ${value.length} 条）`] }
  const problems: string[] = []
  value.forEach((item, i) => {
    const at = `overrides[${i}]`
    if (typeof item !== 'object' || item === null) {
      problems.push(`${at} 必须是对象`)
      return
    }
    const o = item as Record<string, unknown>
    const op = o.op
    if (typeof op !== 'string' || !(OVERRIDE_OPS as readonly string[]).includes(op)) {
      problems.push(`${at}.op 必须是 ${OVERRIDE_OPS.join(' / ')} 之一（收到 ${JSON.stringify(op)}）`)
      return
    }
    if (op === 'setPlacement') {
      if (!Number.isInteger(o.turn) || (o.turn as number) < 1) problems.push(`${at}.turn 必须是正整数`)
      if (!isStringList(o.nodes)) problems.push(`${at}.nodes 必须是字符串数组`)
    } else if (op === 'rename') {
      if (!isNonEmptyString(o.id)) problems.push(`${at}.id 必须是非空字符串`)
      if (!isNonEmptyString(o.title)) problems.push(`${at}.title 必须是非空字符串`)
    } else if (op === 'merge') {
      if (!isStringList(o.from) || o.from.length === 0) problems.push(`${at}.from 必须是非空字符串数组`)
      if (!isNonEmptyString(o.into)) problems.push(`${at}.into 必须是非空字符串`)
      if (o.title !== undefined && !isNonEmptyString(o.title)) problems.push(`${at}.title 若给出必须非空`)
    } else if (op === 'create') {
      if (!isNonEmptyString(o.id)) problems.push(`${at}.id 必须是非空字符串`)
      if (!isNonEmptyString(o.title)) problems.push(`${at}.title 必须是非空字符串`)
      if (!isStringList(o.parents)) problems.push(`${at}.parents 必须是字符串数组`)
      if (o.op === 'reparent' && !isNonEmptyString(o.id)) problems.push(`${at}.id 必须是非空字符串`)
    } else if (op === 'delete') {
      if (!isNonEmptyString(o.id)) problems.push(`${at}.id 必须是非空字符串`)
    }
  })
  return { list: problems.length === 0 ? (value as TaskOverride[]) : null, problems }
}

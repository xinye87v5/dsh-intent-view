#!/usr/bin/env node
/**
 * 真实会话回合的**唯一读取处**（导出脚本与扫描 harness 共用）。
 *
 * 两件事必须只做一次，否则口径会漂：
 *
 * 1. **只认真人 `user/message`**（`tools/session-log.mjs` 里已写明：注入消息会把
 *    "Current runtime context…" 当成 prompt）；
 * 2. **打码联系方式**——真实会话里有姓名/电话/邮箱/微信。
 *    导出的语料只用来研究**任务结构**，不需要这些字段。
 */
import {
  collectSessions, readEvents, buildTurns, usableTurns,
} from '../session-log.mjs'

/** 打码：真实会话里的联系方式不该跟着语料进版本库或日志。 */
export function maskPrompt(text) {
  return String(text)
    .replace(/姓名-\S+/g, '姓名-<已打码>')
    .replace(/微信号?-\S+/g, '微信-<已打码>')
    .replace(/1[3-9]\d{9}/g, '<手机号已打码>')
    .replace(/[\w.+-]+<at>[\w.-]+/g, '<邮箱已打码>')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '<邮箱已打码>')
}

/** 列出所有会话（含回合数），按回合数降序。 */
export function listSessions() {
  const rows = []
  for (const c of collectSessions()) {
    let turns
    try {
      turns = usableTurns(buildTurns(readEvents(c.log))).turns
    } catch {
      continue
    }
    if (turns.length === 0) continue
    rows.push({ id: c.id, log: c.log, count: turns.length, first: String(turns[0]?.prompt ?? '').slice(0, 40) })
  }
  return rows.sort((a, b) => b.count - a.count)
}

/**
 * 取某会话的回合（已打码），形状与合成语料一致：`{turn, prompt}`。
 *
 * `withSteps: true` 时额外带上**每一步的思考**（`steps`）——宿主 fold 的 `statement`
 * 就是从思考里抽的（`goalStatement`），研究侧要复刻那一列就必须拿到它。
 */
export function loadSessionTurns(needle, { maxTurns = 0, withSteps = false } = {}) {
  const session = listSessions().find((c) => c.id.includes(needle))
  if (session === undefined) throw new Error(`找不到会话 ${needle}`)
  const turns = usableTurns(buildTurns(readEvents(session.log))).turns
    .map((t, i) => ({
      turn: i + 1,
      prompt: maskPrompt(String(t.prompt).replace(/\s+/g, ' ').trim()),
      // **agent 实际做了什么**：回复正文（也打码）。判"有没有按用户交办的任务做事"要用它。
      response: maskPrompt(String(t.response ?? '').replace(/\s+/g, ' ').trim()),
      ...(withSteps
        ? { steps: t.steps.map((s) => ({ step: s.step, reasoning: s.reasoning })), early: t.early ?? '' }
        : {}),
    }))
  return { id: session.id, turns: maxTurns > 0 ? turns.slice(0, maxTurns) : turns, total: turns.length }
}

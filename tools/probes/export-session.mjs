#!/usr/bin/env node
/**
 * 把真实会话的**真人回合**导出成语料文本（`#N 正文` 一行一个），
 * 好让流水线像跑合成语料一样跑它。
 *
 * 只认真人 `user/message`——`tools/session-log.mjs` 里已经写明为什么
 * （注入消息会把"Current runtime context…"当成 prompt）。
 *
 * 用法：`node tools/probes/export-session.mjs --id abcd1234 --out research/session-abcd1234.txt`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { collectSessions, readEvents, buildTurns, usableTurns } from '../session-log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const want = arg('--id', 'abcd1234')

const session = collectSessions().find((c) => c.id.includes(want))
if (session === undefined) throw new Error(`找不到会话 ${want}`)
const turns = usableTurns(buildTurns(readEvents(session.log))).turns
/**
 * **打码**：真实会话里有联系方式。导出的语料只用来研究**任务结构**，
 * 不需要这些字段，所以在这里统一抹掉——免得它们跟着语料进版本库或进日志。
 */
const mask = (text) =>
  text
    .replace(/姓名-\S+/g, '姓名-<已打码>')
    .replace(/微信号?-\S+/g, '微信-<已打码>')
    .replace(/1[3-9]\d{9}/g, '<手机号已打码>')
    .replace(/[\w.+-]+<at>[\w.-]+/g, '<邮箱已打码>')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '<邮箱已打码>')

const lines = turns.map((t, i) => `#${i + 1} ${mask(String(t.prompt).replace(/\s+/g, ' ').trim())}`)
const out = arg('--out', path.resolve(ROOT, 'research', `session-${want}.txt`))
writeFileSync(out, lines.join('\n') + '\n')
console.log(`已写入 ${path.relative(process.cwd(), out)}：${session.id} · ${turns.length} 回合`)
console.log(`前三条：`)
for (const l of lines.slice(0, 3)) console.log('  ' + l.slice(0, 90))

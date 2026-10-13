// 思考里那些汉字到底是什么？是"用中文想"，还是"引用用户的话"？
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
let shown = 0
for (const candidate of collectSessions()) {
  let usable
  try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
  if (usable.turns.length < 40) continue
  for (const turn of usable.turns) {
    const runs = turn.early.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []
    if (runs.length < 3) continue
    // 找出汉字周围的英文上下文
    const first = runs[0]
    const at = turn.early.indexOf(first)
    console.log(`── ${candidate.id.slice(8, 14)} #${turn.turn}`)
    console.log('   ' + turn.early.slice(Math.max(0, at - 110), at + 90).replace(/\s+/g, ' '))
    shown += 1
    if (shown >= 6) break
  }
  if (shown >= 6) break
}

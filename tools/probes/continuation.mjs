// 快速看一件事：我那个"承接上一轮"的度量失败了，但**语言里有没有明说**？
import path from 'node:path'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shared = await import(path.join(ROOT, 'lib', 'shared', 'intent.js'))
const CUES = [
  /\b(?:building|going) on (?:the )?(?:earlier|previous|prior|last)\b/i,
  /\b(?:as|like) (?:discussed|mentioned|planned|agreed|before|earlier)\b/i,
  /\b(?:earlier|previous|prior|last) (?:design|plan|turn|step|decision|approach|discussion)\b/i,
  /\bcontinu(?:e|ing) (?:with|from|the)\b/i,
  /\b(?:from|per) (?:the )?(?:earlier|previous) \w+/i,
  /(?:接着|之前|上一(?:轮|步|版)|按(?:之前|上次)|延续|沿用)/,
]
let total = 0, hits = 0
const samples = []
for (const candidate of collectSessions()) {
  let usable
  try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
  if (usable.turns.length < 40) continue
  for (const turn of usable.turns) {
    const st = shared.goalStatement(turn.early)
    if (st === '') continue
    total += 1
    for (const cue of CUES) {
      if (cue.test(st)) {
        hits += 1
        if (samples.length < 6) samples.push(st.slice(0, 130))
        break
      }
    }
  }
  if (total > 0 && samples.length >= 6) break
}
console.log(`抽出的目标句 ${total} 条，其中含**显式承接语**的 ${hits} 条 (${(hits / total * 100).toFixed(0)}%)`)
for (const s of samples) console.log('  ·', s)

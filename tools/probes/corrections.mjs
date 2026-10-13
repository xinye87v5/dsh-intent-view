#!/usr/bin/env node
/**
 * 用**使用者的纠正行为**量"方向偏差"——不花模型钱的客观真值。
 *
 * ## 为什么换这个真值
 *
 * 前面几种口径（组级 57%、会话级 91%、最近实质指令 91%）全都答不倒一个问题：
 * **那些数是不是在量"漂移"？** 实测它们随"参考文本的宽窄"剧烈变化——
 * 参考给 3 条同组 prompt 时 57%，只给 1 条具体指令时 91%。
 * 一句话总结：**它们量的是"这条理解有多像那段参考"，不是"agent 有没有跑偏"。**
 * 所以那些数字**既不能证实也不能否证**"偏差约 5%"这个体感。
 *
 * ## 换成行为真值
 *
 * agent 真的跑偏时，使用者会**纠正**它（"不对""我说的是""回到刚才"）。
 * 这是**使用者的行为**，与任何模型判断无关，也不依赖我造的材料。
 *
 * ⇒ 量两件事：
 *   1. **基线纠正率**：有多少回合后面跟着一次纠正（直接验"约 5%"这个体感）；
 *   2. 若要更进一步，可把纠正与模型的标记 join 起来看精确度——
 *      但那要再花模型调用，先做第 1 件。
 *
 * 用法：`node tools/probes/corrections.mjs [窗口=3]`
 */
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'

/** 纠正线索。**宁窄勿宽**：宽了会把"换个新要求"也算成纠正。 */
const CUES = [
  /^不对/, /^不是/, /^错了/, /^停/, /^别/, /^我说的是/, /^我说过/, /^你搞错/,
  /^跑偏/, /^偏离/, /^回到/, /^重新/, /^我刚才(说|要)的/,
  /^(no|nope|wrong|stop|not what|i said|that's not)/i, /^actually,? (no|not)/i,
]

const WINDOW = Number(process.argv[2] ?? 3)
let total = 0
let corrected = 0
const examples = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  const turns = usable.turns
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].prompt.trim() === '') continue
    total += 1
    // 往后 WINDOW 个"有实质内容的回合"里，有没有一次纠正
    let hit = false
    for (let step = 1; step <= WINDOW && index + step < turns.length; step += 1) {
      const next = turns[index + step].prompt.trim()
      if (CUES.some((cue) => cue.test(next))) {
        hit = true
        if (examples.length < 8) examples.push(next.slice(0, 90))
        break
      }
    }
    if (hit) corrected += 1
  }
}
console.log(`回合 ${total} 个 · 其后 ${WINDOW} 个回合内出现"纠正"的 ${corrected} 个 = ${((corrected / total) * 100).toFixed(1)}%`)
console.log(`\n纠正样本（前 8 条）：`)
for (const text of examples) console.log(`  · ${text}`)
console.log(`\n读法：这就是"方向偏差"的**行为真值**——使用者自己出手纠正的频率。`)
console.log(`它不受参考文本宽窄影响，也不受模型判断影响。`)

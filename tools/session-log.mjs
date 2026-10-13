/**
 * 读真实会话日志的**唯一一份**实现，给 `tools/` 下的研究脚本共用。
 *
 * ## 为什么抽出来
 *
 * 三个脚本各自复制一份"列会话 → 解压 → 切回合"，就会有**三份口径**。
 * 而口径不一致正是本项目反复吃亏的地方（`splitlines` vs `split('\n')`、
 * `roundsStarted` 当回合号错 89 个回合、两个 bigram 实现在同一语料上漂移）。
 *
 * ## 三个踩过的坑，都写在这里
 *
 * 1. **必须 `zstd -dc`，不能用 Node 的 `zstdDecompressSync`**：会话日志是
 *    **多帧**的（每次 append 一帧），Node 那个只解第一帧——840 KB 的日志解出
 *    193 字节，看起来像"日志是空的"。
 * 2. **优先取 `.v3.` 那一代**：目录里同时有 `session.jsonl.zstd`（旧代）。
 *    读到旧代且它是空的，同样看起来像"日志里什么都没有"。
 * 3. **只认真人 `user/message`**（`source.kind === 'user'`）：注入消息会把
 *    "Current runtime context…"这类系统文本当成 prompt——投影里也做了同一层过滤。
 *    实测某 133 回合的会话里 151 条 `user/message` 只有 132 条是真人输入。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 前段思考取多少字符（与 `research/reasoning-phases.md` 的窗口一致）。 */
export const EARLY_WINDOW = 400

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** 所有有当代日志的会话，按体积降序（大的内容多）。 */
export function collectSessions() {
  const found = []
  if (!existsSync(SESSIONS_ROOT)) return found
  for (const project of readdirSync(SESSIONS_ROOT)) {
    const dir = path.join(SESSIONS_ROOT, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      const log = path.join(dir, name, 'session.v3.jsonl.zstd')
      if (existsSync(log)) found.push({ id: name, log, bytes: statSync(log).size })
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes)
}

/** 解压并逐行解析成事件数组（跳过 header 行）。 */
export function readEvents(log) {
  const text = execFileSync('zstd', ['-dc', log], { encoding: 'utf8', maxBuffer: 1 << 30 })
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed.type !== 'session') events.push(parsed)
    } catch {
      // 尾部残行：忽略
    }
  }
  return events
}

export const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : [])

/** 一个消息里某类块的文本拼接。 */
export function joinBlocks(message, type) {
  return blocksOf(message)
    .filter((block) => block?.type === type)
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/**
 * 切回合。
 *
 * 锚点用**与投影同一口径**的回合号：折叠里是"见过几个 `turn/start`"。
 * （`goal/change` 的 `roundsStarted` 是"目标寿命内的计数"，当回合号用会错得离谱
 * ——实测差 89 个回合。）
 *
 * @returns `turns`（每回合 prompt / response / 前段思考 / 逐步思考 / 工具参数）
 *   与两类**外部锚点**（`goal/change` 的 create|clear、`session/title` 重算）。
 */
export function buildTurns(events) {
  const turns = []
  const goalAnchors = []
  const titleAnchors = []
  let current
  let titles = 0
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      current = {
        index: turns.length,
        /**
         * **回合号（1 起）**。与插件折叠里的口径一致：见过几个 `turn/start`。
         *
         * 这个字段曾经漏掉，而症状极具迷惑性：用到它的地方（判定材料、
         * 语言统计的样本打印）全都静默地拿到 `undefined`——
         * 界面上是 `#undefined`，判定那边是**空回合号列表**，于是解析回来
         * 一条都对不上，看起来像"模型不听话"。**标记：#undefined 出现过两次，
         * 我都没追。** 追一次就发现了。
         */
        turn: turns.length + 1,
        prompt: '',
        response: '',
        early: '',
        steps: [],
        toolArgs: [],
      }
      turns.push(current)
      continue
    }
    if (event.type === 'goal/change') {
      const operation = String(data.operation ?? '')
      if (operation === 'create' || operation === 'clear') goalAnchors.push(turns.length)
      continue
    }
    if (event.type === 'session/title') {
      // 第一次是初始标题；之后的每一次都是**标题被重算**（话题变了才会重算）
      titles += 1
      if (titles > 1) titleAnchors.push(turns.length)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'user/message') {
      if ((data.source?.kind ?? 'user') !== 'user') continue
      if (current.prompt !== '') continue
      current.prompt = joinBlocks(data, 'text')
      continue
    }
    if (event.type === 'assistant/message') {
      const reasoning = joinBlocks(data.message, 'reasoning')
      if (reasoning.trim() !== '') {
        if (current.early === '') current.early = reasoning.slice(0, EARLY_WINDOW)
        current.steps.push({ step: Number(data.step ?? current.steps.length + 1), reasoning })
      }
      const text = joinBlocks(data.message, 'text')
      // **每次都覆盖**：官方 `turnOutline` 在 `turn/end` 时提交**最新**一条带文本的
      // assistant 消息。取第一条会让文本与官方不一致。
      if (text.trim() !== '') current.response = text
      continue
    }
    if (event.type === 'tool/call') current.toolArgs.push(String(data.arguments ?? ''))
  }
  return { turns, goalAnchors, titleAnchors }
}

/** 只保留有 prompt 与 response 的回合，并把锚点下标重映射过去。 */
export function usableTurns(built) {
  const kept = built.turns.filter((turn) => turn.prompt !== '' && turn.response !== '')
  const remap = new Map()
  let next = 0
  for (const turn of built.turns) {
    if (turn.prompt !== '' && turn.response !== '') remap.set(turn.index, next++)
  }
  const remapAll = (list) => list.map((t) => remap.get(t)).filter((v) => v !== undefined)
  return { turns: kept, goalAnchors: remapAll(built.goalAnchors), titleAnchors: remapAll(built.titleAnchors) }
}

/**
 * "具体产物"：文件路径、`#N` 回合号、反引号里的标识符。
 *
 * 产物比整体词面**尖锐**——它只看名词性的东西，而那才是"承接"该留下的痕迹。
 */
export function artifacts(text) {
  const out = new Set()
  const source = String(text ?? '')
  for (const match of source.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:md|py|mjs|cjs|ts|tsx|json|svg|ya?ml|toml)/g)) {
    out.add(match[0].toLowerCase())
  }
  for (const match of source.matchAll(/#\d+/g)) out.add(match[0])
  for (const match of source.matchAll(/`([^`\n]{2,40})`/g)) out.add(match[1].trim().toLowerCase())
  return out
}

/** 集合交集占左集合的比例；左集合空时返回 null（**不是 0**——没有样本不等于不重合）。 */
export function containment(left, right) {
  if (left.size === 0) return null
  let shared = 0
  for (const item of left) if (right.has(item)) shared += 1
  return shared / left.size
}

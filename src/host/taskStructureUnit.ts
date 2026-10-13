/**
 * 任务结构的**宿主单元**：跑那条冻结的四段流水线，把结构交给面板。
 *
 * ## 契约照抄 `semanticUnit.ts`（那是本项目唯一验证过的模型调用通道）
 *
 * - `ctx.get('llm').stream({...})` + `BlockAssembler` 收文本；
 * - `reasoningEffort: 'off'` + `temperature: 0`：结构标注是抽取活，开思考只会更慢更贵
 *   （实测开思考 1204 chunk / 一百多秒 → 关掉 239 chunk / 约 5 秒）；
 * - **硬超时**：`llm.stream` 不理会 abort 时界面会永远停在"正在算…"，
 *   所以 `Promise.race` 兜一层；
 * - 结论**不落会话日志**（`Session.append` 不写 `ignorable`，写自定义事件会让别的构建
 *   拒绝重建会话）——所以这里只算、只返回，由面板消费。
 *
 * ## 与语义核查那条路的关系
 *
 * 两条路各自独立：语义核查判"某个回合是否偏离组意图"，本单元给"任务结构"。
 * 分开的理由是**失败面不同**：结构这条要多轮调用（1 建 + N 批 + 1 整理 + 0/1 裁定），
 * 任何一段挂了都该只影响自己，而不是把面板整块打不开。
 *
 * ## 可离线测
 *
 * `runStructurePipeline` 收的是**注入进来的 llm 与 route**，所以
 * `scripts/verify-task-structure.cjs` 能用假 llm（异步生成器）把整条流水线跑完，
 * 断言调用次数、顺序、缓存与在飞去重——不需要真模型、不花调用。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ADJUDICATE_PROMPT, ASSIGN_PROMPT, BUILD_PROMPT, CONSOLIDATE_PROMPT, SYS,
  applyAdjudication, applyAssign, applyConsolidate, applyIncrement, carryForward, fillPrompt, finalize,
  isContinuation, isPrefixExtension, nodeList, renderRoots, renderTurns, rootSummary,
  type Turn,
} from '../shared/taskPipeline.js'
import type { TaskGraph } from '../shared/taskGraph.js'
import { STRUCTURE_CACHE_VERSION, loadStructureCache, pruneStructureCache, saveStructureCache } from './structureStore.js'

export const STRUCTURE_PATH = '/api/intent.structure'

/** 一次结构计算的账，回给面板便于排查（"为什么只问了 3 批"这类问题）。 */
export interface StructureMeta {
  calls: number
  batches: number
  /** 这次是否补跑过"定期判整理"（增量路才有）。 */
  consolidated?: boolean
  /** 上次整理完的节点数——下次拿它算"距上次整理新增了几个节点"。 */
  nodesAtConsolidate?: number
  /** 这次是否补跑过"定期根裁定"（增量路才有）。 */
  adjudicated?: boolean
  /**
   * **这份结构覆盖了多少个回合**（保存时的 `turns.length`）。
   *
   * 缓存命中时靠它判断"请求带的回合是不是更多"——不记这个数就只能盲回缓存，
   * 于是"同一个指纹 + 更多回合"会拿到**旧结构**（见 `canServeCached`）。
   */
  turnsCovered?: number
  /**
   * **这次被跳过的段 + 为什么**（`判整理跳过了：…`）。
   *
   * 可选段（判整理 / 根裁定 / 补问归属）失败不再丢掉整份结构，但**必须说出来**——
   * 静默跳过等于让人以为"结构就这样"。
   */
  skipped?: string[]
  /** 根裁定分了几组。 */
  adjudicateGroups?: number
  /** 上次裁定之后的顶层构成（签名）——下次拿它判断"顶层变没变"。 */
  rootsAtAdjudicate?: string
  /** 整理那次调用：模型给了几条 op、应用了几条、被拒几条（判断"空操作"的原因用）。 */
  consolidateOps?: number
  consolidateApplied?: number
  consolidateRejected?: number
  /** 一次建结构的窗口大小与后续每批的回合数。 */
  firstWindow: number
  chunk: number
  adjudication: 'no-roots' | 'asked' | 'merged'
  /**
   * 这次是**全量建**还是**增量接**。
   *
   * 面板与探针都靠它分辨"这次花了几次调用、为什么"。增量只在
   * "同一会话、回合是前缀延长"时发生（见 `isPrefixExtension`）。
   */
  mode?: 'full' | 'incremental'
  /** 增量那一次新接上去的回合数。 */
  addedTurns?: number
  /** 增量时被丢掉的越界落点条数（>0 说明模型顺手改了老回合，见 `applyIncrement`）。 */
  ignoredPlacements?: number
  /** 增量时与已有 id 撞名而丢掉的新节点数。 */
  collidedNodes?: number
  inherited: number
  reasked: number
  /** 各段耗时（毫秒），用来发现"哪一段最慢"。 */
  elapsedMs: number
}

export interface StructureResult {
  state: TaskGraph
  roots: ReturnType<typeof rootSummary>
  meta: StructureMeta
}

/** 模型调用：一段提示 → 文本。可被测试替换。 */
export interface StreamLike {
  stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
}

interface Route { provider: string; model: string }

/** 把 `llm.stream` 的块拼成文本（与 semanticUnit 同一写法）。 */
async function callModel(
  llm: StreamLike,
  route: Route | undefined,
  system: string,
  prompt: string,
  options: { sessionId: string; maxTokens: number; signal?: AbortSignal },
): Promise<string> {
  const assembler = new BlockAssembler()
  if (route === undefined) throw new Error('没有可用的模型路由（route 未配置）')
  // `llm.stream` 的块类型由 DSH 提供，这里只关心"能 push 进 assembler"
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-intent-view' },
      }),
    ],
    // 结构标注是抽取活，关思考：实测开思考 1204 chunk / 一百多秒 → 关掉 239 chunk / 约 5 秒
    reasoningEffort: 'off',
    temperature: 0,
    maxTokens: options.maxTokens,
    sessionId: options.sessionId,
    signal: options.signal,
  }) as AsyncIterable<never>) {
    assembler.push(chunk)
  }
  return assembler
    .blocks()
    .map((block) => (block.type === 'text' ? (block as { text?: string }).text ?? '' : ''))
    .join('')
}

/**
 * **截断修复**：模型回复被 `maxTokens` 截断时，把"完整的前缀"救回来。
 *
 * 使用者实测（2026-10-14，3080）：
 * `判整理 的回复不是合法 JSON：Unterminated string in JSON at position 3121`
 * ——那一整份结构就没了。判整理只是四段里的**第三段**（可选精修），
 * 不该因为它的回复被截断就把前两段算出来的东西全丢掉。
 *
 * 做法保守、可解释：
 * 1. 逐字符走一遍（认识字符串与转义），把**可切的边界**都记下来
 *    （刚写完一个值：字符串/对象/数组结束处，或一个逗号前）；
 * 2. 从最靠后的边界往前试：截在那里、把还没闭合的括号补上，**第一个真能解析的就是它**；
 * 3. 一个都不成 ⇒ 返回 `null`（调用方仍按原来的"不是合法 JSON"报错）。
 *
 * 为什么要"试"而不是直接取最后一个边界：不是每个边界都落在合法位置上。
 * `{"op":"x"` 这种"键写完、值没写"的边界补成 `{"op"}` 是**语法不成立**的，
 * 往前退一个边界才对。上限 50 次，只为防病态输入。
 *
 * 括号本来就闭合（不是截断）时返回 `null`——不许"修"一份本来只是语法错的东西。
 */
export function repairTruncatedJson(raw: string): string | null {
  const text = raw.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  const stack: string[] = []
  const cuts: { at: number; closers: string }[] = []
  const mark = (at: number): void => {
    if (stack.length > 0) cuts.push({ at, closers: stack.slice().reverse().join('') })
  }
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') { inString = false; mark(i + 1) }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); continue }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null
      stack.pop()
      mark(i + 1)
      continue
    }
    if (ch === ',') mark(i)
  }
  if (stack.length === 0) return null // 括号本来就闭合：不是截断，别乱修
  for (let i = cuts.length - 1, tried = 0; i >= 0 && tried < 50; i -= 1, tried += 1) {
    const candidate = text.slice(0, cuts[i].at) + cuts[i].closers
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // 这个边界不成：再往前退一个
    }
  }
  return null
}

/**
 * **缓存命中能不能直接回？**
 *
 * 原来命中就回，于是"同一个指纹 + 更多回合"会拿到**旧结构**——增量根本不跑，
 * 而日志里看着还很省（`cached: true`、0.0 秒）。这是做"定期根裁定 A/B"时踩到的：
 * 探针固定 `--hash`，从第二个前缀开始全是旧结构（覆盖 20/70、20/120…），
 * 而那种读数会被误当成"增量没生效"或"结构没长"。
 *
 * 规则：**请求的回合数不比缓存覆盖的多**才直接回；多了就走增量（`memo` 里有旧结构）。
 * 老条目（没有 `turnsCovered`）保持旧行为——不能凭猜测改语义。
 *
 * 导出是为了离线断言（三条边界：老条目 / 一样多 / 更多）。
 */
export function canServeCached(meta: { turnsCovered?: number } | undefined, requestedTurns: number): boolean {
  const covered = meta?.turnsCovered
  if (typeof covered !== 'number' || !Number.isFinite(covered)) return true
  return requestedTurns <= covered
}

function parseJson(raw: string, where: string, notes?: string[]): any {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const repaired = repairTruncatedJson(raw)
    if (repaired !== null) {
      try {
        const value = JSON.parse(repaired)
        // **不静默**：救回来了也要留一笔（面板上那句会说明"按完整前缀救回"）
        notes?.push(`${where}：回复被截断，已按完整的前缀救回（尾部丢弃）`)
        return value
      } catch {
        // 修完还是不行：走下面的原样报错
      }
    }
    throw new Error(`${where} 的回复不是合法 JSON：${(error as Error).message}｜开头：${raw.slice(0, 120)}`)
  }
}

/**
 * 跑完四段。**纯编排**：所有状态变换都调 `shared/taskPipeline.ts` 里那份
 * （与研究工具逐字交叉校验过，见 `scripts/verify-task-pipeline-port.cjs`）。
 */
export async function runStructurePipeline(options: {
  turns: Turn[]
  llm: StreamLike
  route: Route
  sessionId: string
  firstWindow?: number
  chunk?: number
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<StructureResult> {
  const { turns, llm, route, sessionId } = options
  const firstWindow = options.firstWindow ?? 20
  const chunk = options.chunk ?? 12
  const log = options.log ?? (() => {})
  if (turns.length === 0) throw new Error('没有回合可跑')
  const started = Date.now()
  let calls = 0
  /**
   * **这次有哪些段被跳过了**（面板会显示）。
   *
   * 为什么要它：四段里只有"建结构"是"没有就没有结构"。判整理 / 根裁定 / 补问都是
   * **可选精修**，而它们原来一旦失败（模型回复被截断、超时、不是合法 JSON）就把整份结构丢掉，
   * 使用者看到的是"任务结构：这次没算成"——**已经算出来的东西也跟着没了**（实测 2026-10-14）。
   */
  const notes: string[] = []
  const ask = async (prompt: string, maxTokens: number, where: string): Promise<any> => {
    // 计数留在全量这边（它是全量的账）；真正那次调用在 `askModel` 里，与增量共用。
    const parsed = await askModel(llm, route, prompt, maxTokens, sessionId, where, options.signal, notes)
    calls += 1
    return parsed
  }
  /** 可选段：失败就记一笔、跳过这一段，**绝不把已有结构一起丢掉**。 */
  const askSoft = async (prompt: string, maxTokens: number, where: string): Promise<any> => {
    try {
      return await ask(prompt, maxTokens, where)
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      notes.push(`${where}跳过了：${detail}`)
      log(`⚠ ${where}跳过了（${detail.slice(0, 140)}）——这一段不生效，其余照常`)
      return undefined
    }
  }

  // ① 建结构
  const head = turns.slice(0, Math.min(firstWindow, turns.length))
  const built = await ask(fillPrompt(BUILD_PROMPT, { turns: renderTurns(head) }), 2500, `建结构（第 1–${head.length} 回合）`)
  let state: TaskGraph = { nodes: built?.nodes ?? {}, membership: built?.membership ?? {} }
  log(`建结构：${head.length} 回合 → ${Object.keys(state.nodes).length} 个节点`)

  // ② 分批判归属
  const rest = turns.slice(head.length)
  let batches = 0
  for (let start = 0; start < rest.length; start += chunk) {
    const slice = rest.slice(start, start + chunk)
    const where = `判归属（第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合）`
    // ② 也**不硬失败**：批次断在这里时前面几批已经进 `state` 了，丢掉太亏
    let reply: any
    try {
      reply = await ask(
        fillPrompt(ASSIGN_PROMPT, { nodes: nodeList(state.nodes), turns: renderTurns(slice) }),
        1600,
        where,
      )
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      notes.push(`${where}断了：${detail}`)
      log(`⚠ ${where}断了（${detail.slice(0, 140)}）——后面几批不再问，已算出来的照常显示`)
      break
    }
    const applied = applyAssign(state, reply)
    state = { nodes: applied.nodes, membership: applied.membership }
    batches += 1
    log(`判归属 ${batches}：第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合 · 节点 ${Object.keys(state.nodes).length}`)
  }

  // ③ 节点层面的整理（合并/改名只能在这一段发生）——**可选段**
  const consolidated = await askSoft(
    fillPrompt(CONSOLIDATE_PROMPT, { nodes: nodeList(state.nodes) }),
    // 1200 会把 op 列表**截断**（实测：回复断在 3121 字符的字符串中间）；给足余量，
    // 再配上 `repairTruncatedJson` 兜底
    2400,
    '判整理',
  )
  const afterConsolidate = applyConsolidate(state, consolidated?.ops)
  state = { nodes: afterConsolidate.nodes, membership: afterConsolidate.membership }

  // ④ 根裁定（只在顶层 ≥2 个非插话节点时问一次）——**可选段**
  let adjudication: StructureMeta['adjudication'] = 'no-roots'
  const before = rootSummary(state, turns)
  if (before.projects.length >= 2) {
    const verdict = await askSoft(
      fillPrompt(ADJUDICATE_PROMPT, { roots: renderRoots(state, turns) }),
      400,
      `根裁定（${before.projects.length} 个顶层）`,
    )
    if (verdict !== undefined) {
      const applied = applyAdjudication(state, verdict, before.projects)
      state = applied.state
      adjudication = applied.applied ? 'merged' : 'asked'
      log(`根裁定：分成 ${(verdict?.groups ?? []).length} 组` + (applied.applied ? ` → 建 ${applied.merged.length} 个项目节点` : ''))
    }
  }

  // ⑤ 覆盖：实质回合补问一次，承接语交给 carryForward（真实会话 5–27% 的回合没归属）——**可选段**
  const missing = turns.filter((t) => (state.membership[String(t.turn)] ?? []).length === 0)
  const substantive = missing.filter((t) => !isContinuation(t.prompt))
  let reasked = 0
  if (substantive.length > 0) {
    const reply = await askSoft(
      fillPrompt(ASSIGN_PROMPT, { nodes: nodeList(state.nodes), turns: renderTurns(substantive) }),
      1600,
      `补问归属（${substantive.length} 个漏掉的回合）`,
    )
    if (reply !== undefined) {
      const applied = applyAssign(state, reply)
      state = { nodes: applied.nodes, membership: applied.membership }
      reasked = substantive.length
    }
  }
  const carried = carryForward(state, turns)
  state = carried.state

  // ⑥ 收尾：结构闸门不设阈值（根按语义划分），只做 strip（存最具体落点）
  const finished = finalize(state, turns)

  return {
    state: finished.state,
    roots: finished.roots,
    meta: {
      calls,
      batches,
      mode: 'full',
      firstWindow,
      chunk,
      adjudication,
      inherited: carried.inherited.length,
      reasked,
      elapsedMs: Date.now() - started,
      turnsCovered: turns.length,
      // 只有真跳过了才带这个字段（空数组会让面板多一行没意义的字）
      ...(notes.length === 0 ? {} : { skipped: notes }),
    },
  }
}

// ── 路由：缓存 + 在飞去重 + 失败不抛 ──────────────────────────────────────

/**
 * 一次会话的结构缓存。
 *
 * 键是 `sessionId + contentHash`——面板把材料（回合正文的指纹）一起发过来，
 * 内容没变就不再问模型。**只缓存成功**：失败要能重试（把失败也缓存住的话，
 * 一次网络抖动会让这个会话永久显示不出结构）。
 */
const cache = new Map<string, StructureResult>()
/** 落盘的上限：一个会话一条键，几百条够用；按插入顺序丢最旧的。 */
const STRUCTURE_CACHE_MAX = 300
/**
 * **磁盘那份只读一次**（`structureStore.ts`）：宿主重启不该让每个会话都全量重算一次。
 * 内存那份仍然是权威的（命中就是命中），磁盘只是它的初值与落盘副本。
 *
 * ⚠️ 读盘是 async 的，而缓存查询要在同步路径上做 ⇒ 在请求入口先 `await` 一次这个
 * promise（只第一次真读）。**不能在模块顶层 await**：那会让整个模块图变成 async，
 * 而 `verify-task-structure.cjs` 用 `require()` 载入本文件（Node 的 require(esm)
 * 遇到 async 图直接抛 ERR_REQUIRE_ASYNC_MODULE）。
 */
let diskLoaded: Promise<void> | undefined
function ensureDiskCache(): Promise<void> {
  diskLoaded ??= (async () => {
    for (const [key, value] of await loadStructureCache<StructureResult>(STRUCTURE_CACHE_VERSION)) {
      if (!cache.has(key)) cache.set(key, value)
    }
  })().catch(() => {
    // **读盘失败绝不能让请求失败**：缓存坏了只该退化成"没有缓存"
  })
  return diskLoaded
}
const inflight = new Map<string, Promise<StructureResult>>()

/**
 * **会话级记忆**：`sessionId` → 上一版结构 + **它当时覆盖的那批回合**。
 *
 * 这是增量归属的入口：新请求若与记忆里的回合逐字前缀相同、只是更长，
 * 就只把**多出来的那些回合**接上去（1 批 = 1 次调用），不再整场重算。
 * 没有它的话，`cache` 只能做到"完全没变才免费"——而会话是活的，
 * 新来一个回合 `contentHash` 就变了（实测 377 回合那场整场重算 33 次调用 / 41.7 秒）。
 *
 * 只记最近一次：会话的历史被压缩改写时前缀会不匹配，那时自动回退全量。
 */
const memo = new Map<string, { turns: Turn[]; result: StructureResult }>()

export function structureCacheKey(sessionId: string, contentHash: string, firstWindow: number, chunk: number): string {
  return `${sessionId}::${contentHash}::${firstWindow}::${chunk}`
}

/**
 * 读一个环境开关。
 *
 * 不直接写 `process.env`：本项目 `tsconfig` 没有 node 类型（`src/index.ts` 也明写
 * "本插件不碰文件系统"），所以从 `globalThis` 上取——既拿到运维开关（`…=1` 时绕过缓存），
 * 又不引入 `@types/node`。
 */
function envFlag(name: string): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name] === '1'
}

/** 测试与运维用：清掉缓存（`DSH_INTENT_STRUCTURE_NOCACHE=1` 时请求也不会读缓存）。 */
export function clearStructureCache(): void {
  cache.clear()
}

export interface StructureDeps {
  llm: StreamLike | undefined
  route: Route
  log?: (line: string) => void
}

/**
 * **定期判整理的阈值**：新增节点累计到这么多，就补跑一次判整理。
 *
 * ## 为什么必须有它（不是"锦上添花"）
 *
 * 增量**不跑**判整理/根裁定（那两段会重排已有结构，与"已有结构不许重排"冲突），
 * 而归属那一段的默认行为是"分不清就新建一个节点"。于是每来一批新回合就多几个
 * 单回合节点，长期退化成"一堆节点、每个只收一个回合"——上一轮实测过这个形态
 * （225 个节点里 171 个只收 1 个回合）。
 *
 * 折中：**平时不动，攒够一批再整理一次**。整理只做合并/改名，且**只在这一个会话的
 * 增量路上**触发——用户手动改过的落点（B4）仍然是覆盖层，不受影响。
 */
/**
 * **定期判整理的生产默认：关**（0 = 永不整理）。
 *
 * 跑过 A/B 之后的实测：它触发 8 次、花 8 次调用、**改动 0**（日志里 8/8 都是 `节点 X → X`）
 * ——提示词明确写着"只改必要的，不要为了少而合并"，所以它对"一堆单回合节点"这个形态
 * 本来就不动手。机制成立（该跑就跑、只跑一次），但**没有正面效果**，默认开着只是白花调用。
 * 要开：`DSH_INTENT_CONSOLIDATE_EVERY=6`。
 */
export const CONSOLIDATE_EVERY_NODES = 0

/**
 * **定期根裁定**的开关：`DSH_INTENT_ADJUDICATE=0/false/off` 关掉。
 * 与"定期判整理"分开一个开关：两者改的东西不同（判整理合并节点、根裁定建项目节点）。
 */
export function adjudicateEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const flag = env?.DSH_INTENT_ADJUDICATE
  if (flag === undefined || flag === '') return true
  return !(flag === '0' || flag === 'false' || flag === 'off')
}

/**
 * 实际用的阈值：`DSH_INTENT_CONSOLIDATE_EVERY` 可覆盖（0 = 关掉定期整理）。
 * 可配是为了**能量**：对照实验要跑"从不整理"与"攒够就整理"两条臂，
 * 否则"补整理到底有没有让结构收拢"只能靠嘴说。
 */
export function consolidateThreshold(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const raw = env?.DSH_INTENT_CONSOLIDATE_EVERY
  // ⚠️ 变量**不在**时必须走默认值：`Number('')` 是 0，而 0 的语义是"永不整理"
  // ——第一版写成 `Number(env ?? '')`，于是没设变量就等于把定期整理关掉了
  //（断言当场抓到：那条"攒够就整理"的用例红了）。
  if (raw === undefined || raw === '') return CONSOLIDATE_EVERY_NODES
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CONSOLIDATE_EVERY_NODES
}

/**
 * 该不该补一次判整理：**距上次整理以来新增的节点数**达到阈值。
 *
 * 用"距上次整理"而不是"距上次调用"，否则每个回合加一个节点就永远攒不够。
 * `nodesAtConsolidate` 存在 `meta` 里 ⇒ 跟着结构一起进缓存与磁盘，
 * 宿主重启后计数不会从零开始。
 */
export function shouldConsolidate(
  nodeCount: number,
  nodesAtConsolidate: number | undefined,
  threshold: number = CONSOLIDATE_EVERY_NODES,
): boolean {
  const base = nodesAtConsolidate ?? 0
  // 阈值 0（或负数）⇒ **永不整理**（对照实验的那条"从不整理"臂）
  if (threshold <= 0) return false
  return nodeCount - base >= threshold
}

/**
 * **增量归属**：把 `fresh` 这批新回合接到 `previous` 那棵已有结构上。
 *
 * 只做一件事：按批把新回合归属到已有节点（或新建节点）。**不做**建结构、判整理、
 * 根裁定——那三段都会重排已有结构。承接语用 `carryForward` 补齐（与全量同一套规则）。
 *
 * 与全量的另一个差别：**不补问**。全量在覆盖不足时会为漏掉的实质回合再问一次；
 * 增量只在一小撮新回合上工作，补问的成本与收益不成比例（而且全量的经验是
 * "承接继承才是主力，补问不可靠"，见 `research/session-sweep-2026-10-09.md`）。
 */
async function incrementStructure(options: {
  previous: StructureResult
  fresh: Turn[]
  turns: Turn[]
  llm: StreamLike
  route: Route | undefined
  sessionId: string
  chunk: number
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<StructureResult> {
  const { previous, fresh, turns, llm, route, sessionId, chunk, signal, log } = options
  if (fresh.length === 0) throw new Error('没有新回合可接')
  const started = Date.now()

  let state: TaskGraph = previous.state
  let calls = 0
  let batches = 0
  let ignoredPlacements = 0
  let collidedNodes = 0
  /** 这次跳过/退回了什么（面板会显示，见 `StructureMeta.skipped`）。 */
  const notes: string[] = []

  for (let start = 0; start < fresh.length; start += chunk) {
    const slice = fresh.slice(start, start + chunk)
    const where = `增量归属（第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合）`
    let reply: any
    try {
      reply = await askModel(
        llm,
        route,
        fillPrompt(ASSIGN_PROMPT, { nodes: nodeList(state.nodes), turns: renderTurns(slice) }),
        1600,
        sessionId,
        where,
        signal,
        notes,
      )
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      /**
       * **退回上一次那份结构，而不是报"没算成"。**
       *
       * 增量是对**已经有结构**的会话做的：这一步挂了不该让面板空掉，上次那份仍然成立
       * （只是不含这批新回合）。使用者实测过"整份结构突然没算成"的观感有多糟。
       */
      notes.push(`${where}断了：${detail}`)
      void log?.(`⚠ ${where}断了（${detail.slice(0, 140)}）——退回上一次的结构（不含这批新回合）`)
      return {
        state: previous.state,
        roots: previous.roots,
        meta: {
          ...previous.meta,
          mode: 'incremental',
          calls,
          batches,
          addedTurns: 0,
          ignoredPlacements,
          collidedNodes,
          skipped: [...(previous.meta.skipped ?? []), ...notes],
          elapsedMs: Date.now() - started,
        },
      }
    }
    const applied = applyIncrement(state, reply, slice.map((t) => t.turn))
    state = { nodes: applied.nodes, membership: applied.membership }
    ignoredPlacements += applied.ignored
    collidedNodes += applied.collisions
    calls += 1
    batches += 1
    void log?.(`增量归属 ${batches}：第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合 · 节点 ${Object.keys(state.nodes).length}`)
  }

  /**
   * **定期判整理**（见 `shouldConsolidate` 的说明）：攒够新增节点就补一次，
   * 把散落的单回合节点合并/改名，免得结构越用越碎。一次调用，失败不影响本次结果
   * （整理是"更好"，不是"必需"——整理挂了就用没整理的那份）。
   */
  const nodesBefore = Object.keys(previous.state.nodes).length
  const nodesNow = Object.keys(state.nodes).length
  let nodesAtConsolidate = previous.meta.nodesAtConsolidate ?? nodesBefore
  let consolidated = false
  /** 整理那次调用到底改了什么（进 meta，面板与探针都看得到）。 */
  let consolidateOps = 0
  let consolidateApplied = 0
  let consolidateRejected = 0
  if (shouldConsolidate(nodesNow, nodesAtConsolidate, consolidateThreshold())) {
    try {
      const reply = await askModel(
        llm,
        route,
        fillPrompt(CONSOLIDATE_PROMPT, { nodes: nodeList(state.nodes) }),
        // 与全量同因：1200 会把 op 列表截断（实测回复断在 3121 字符的字符串中间）
        2400,
        sessionId,
        '定期判整理（增量累积）',
        signal,
        notes,
      )
      const ops = Array.isArray(reply?.ops) ? reply.ops : []
      const applied = applyConsolidate(state, ops)
      state = { nodes: applied.nodes, membership: applied.membership }
      calls += 1
      consolidated = true
      consolidateOps = ops.length
      // `applyConsolidate` 只回 `{nodes, membership, unknown}`（未知 op 名进 unknown），
      // 没有 applied/rejected 那两个字段——不存在的账不许编
      consolidateApplied = ops.length - applied.unknown.length
      consolidateRejected = applied.unknown.length
      nodesAtConsolidate = Object.keys(state.nodes).length
      /**
       * **把"整理到底改了什么"记全**。
       *
       * 之前只打 `节点 X → Y`，而实测 8 次全是 `X → X` ——看不出是"模型认为不用改"
       * 还是"改了但被校验层拒了"。这两种情况的处置完全不同（前者说明提示词太保守，
       * 后者说明规则打架），不记全就只能猜。
       */
      void log?.(
        `定期判整理：新增节点累计到 ${nodesNow - (previous.meta.nodesAtConsolidate ?? nodesBefore)} 个 ⇒ 整理一次，` +
          `节点 ${nodesNow} → ${Object.keys(state.nodes).length}` +
          ` · ops ${ops.length}（应用 ${consolidateApplied} · 拒 ${consolidateRejected}）` +
          (consolidateRejected > 0 ? ` ⚠ 未知 op：${applied.unknown.slice(0, 3).join('、')}` : '') +
          (ops.length === 0 ? ' · 模型认为不用改' : ''),
      )
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      notes.push(`定期判整理跳过了：${detail}`)
      void log?.(`定期判整理失败（不影响本次结构）：${detail.slice(0, 120)}`)
    }
  }

  /**
   * **定期根裁定**（B3）：增量**不跑**根裁定，而它的职责正是"多条顶层线并成一个项目"。
   * 少了这一步，长期会长出几条并排的顶层线（谁也不归谁）。
   *
   * 触发比判整理**更具体**：顶层非插话节点 ≥2 个（那正是根裁定存在的理由），
   * 且顶层构成与上次裁定之后相比变过（签名存 `meta.rootsAtAdjudicate`，跟着缓存与磁盘走）。
   * 裁定会新建项目节点并改挂顶层，但**不动任何已有节点的 id** ⇒ 人工覆盖（按 id 认路）不受影响。
   */
  let adjudicated = false
  let adjudicateGroups = 0
  const rootsNow = rootSummary(state, turns)
  const rootSignature = rootsNow.projects.slice().sort().join(',')
  if (
    adjudicateEnabled() &&
    rootsNow.projects.length >= 2 &&
    rootSignature !== (previous.meta.rootsAtAdjudicate ?? '')
  ) {
    try {
      const verdict = await askModel(
        llm,
        route,
        fillPrompt(ADJUDICATE_PROMPT, { roots: renderRoots(state, turns) }),
        400,
        sessionId,
        `定期根裁定（${rootsNow.projects.length} 个顶层）`,
        signal,
        notes,
      )
      const applied = applyAdjudication(state, verdict, rootsNow.projects)
      state = applied.state
      calls += 1
      adjudicated = true
      adjudicateGroups = Array.isArray(verdict?.groups) ? verdict.groups.length : 0
      void log?.(
        `定期根裁定：${rootsNow.projects.length} 条顶层线 → 分成 ${adjudicateGroups} 组` +
          (applied.applied ? ` · 建 ${applied.merged.length} 个项目节点` : ' · 模型认为该各自成组'),
      )
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      notes.push(`定期根裁定跳过了：${detail}`)
      void log?.(`定期根裁定失败（不影响本次结构）：${detail.slice(0, 120)}`)
    }
  }

  const carried = carryForward(state, turns)
  const finished = finalize(carried.state, turns)
  /**
   * **顶层签名只在"真裁定过"时才写。**
   *
   * 原先这里无条件写"当前顶层签名"，于是两种情况签名都成了谎话：
   *  ① `DSH_INTENT_ADJUDICATE=0`（关着）时也写 ⇒ 再打开时"以为已经裁定过"，
   *     顶层不变就**永远不再裁定**；
   *  ② 裁定那次调用**失败**时也写 ⇒ 那次失败**永远不会重试**。
   * 两种都表现为"该归并的顶层线一直并排着"，而日志里看不出异常——所以必须留旧值。
   */
  const rootsAtAdjudicate = adjudicated
    ? rootSummary(state, turns).projects.slice().sort().join(',')
    : previous.meta.rootsAtAdjudicate
  return {
    state: finished.state,
    roots: finished.roots,
    meta: {
      calls,
      batches,
      mode: 'incremental',
      consolidated,
      adjudicated,
      adjudicateGroups,
      ...(rootsAtAdjudicate === undefined ? {} : { rootsAtAdjudicate }),
      nodesAtConsolidate,
      consolidateOps,
      consolidateApplied,
      consolidateRejected,
      chunk,
      addedTurns: fresh.length,
      ignoredPlacements,
      collidedNodes,
      firstWindow: 0,
      adjudication: previous.meta.adjudication,
      inherited: carried.inherited.length,
      reasked: 0,
      elapsedMs: Date.now() - started,
      turnsCovered: turns.length,
      // 跳过了什么要说出来（含上一次结构里已经记着的那些）
      ...(notes.length === 0 ? {} : { skipped: [...(previous.meta.skipped ?? []), ...notes] }),
    },
  }
}

/** 一次模型调用 + 解析：全量与增量共用（不各写一遍）。 */
async function askModel(
  llm: StreamLike,
  route: Route | undefined,
  prompt: string,
  maxTokens: number,
  sessionId: string,
  where: string,
  signal?: AbortSignal,
  notes?: string[],
): Promise<any> {
  const raw = await callModel(llm, route, SYS, prompt, { sessionId, maxTokens, signal })
  return parseJson(raw, where, notes)
}

/**
 * 处理一次请求。**逻辑与路由分开**，这样它能被离线测（注入假的 llm/route）。
 *
 * 请求体：`{ sessionId, contentHash, turns: [{turn, prompt}], firstWindow?, chunk? }`
 * 响应：
 * - `{ ok:true, structure, roots, meta }`
 * - `{ ok:false, error }`（失败不抛，面板照常显示其余部分）
 */
export async function handleStructureRequest(
  request: { json: () => Promise<unknown> },
  deps: StructureDeps,
): Promise<{ status: number; body: unknown }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } }
  }
  const body = (raw ?? {}) as {
    sessionId?: unknown; contentHash?: unknown; turns?: unknown
    firstWindow?: unknown; chunk?: unknown
  }
  if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
    return { status: 400, body: { ok: false, error: 'sessionId 缺失' } }
  }
  if (!Array.isArray(body.turns)) return { status: 400, body: { ok: false, error: 'turns 必须是数组' } }
  const turns: Turn[] = body.turns
    .map((t) => {
      const row = (t ?? {}) as { turn?: unknown; prompt?: unknown }
      return { turn: Number(row.turn), prompt: String(row.prompt ?? '') }
    })
    .filter((t) => Number.isInteger(t.turn) && t.turn > 0)
  if (turns.length === 0) return { status: 400, body: { ok: false, error: 'turns 里没有合法回合' } }

  await ensureDiskCache()
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : String(turns.length)
  const firstWindow = Number.isInteger(body.firstWindow) ? Number(body.firstWindow) : 20
  const chunk = Number.isInteger(body.chunk) ? Number(body.chunk) : 12
  const key = structureCacheKey(body.sessionId, contentHash, firstWindow, chunk)
  const noCache = envFlag('DSH_INTENT_STRUCTURE_NOCACHE')

  if (!noCache && cache.has(key)) {
    const hit = cache.get(key) as StructureResult
    /**
     * **命中缓存也要写 memo**（增量归属的入口就是它）。
     *
     * 漏掉这一步的后果：重启后第一次请求命中磁盘缓存、看着很省，但 memo 是空的
     * ⇒ **下一个请求（新内容）没有可接的旧结构，只能全量重算**——磁盘缓存的价值
     * 被吃掉一半。这也是我做"补整理 A/B"时发现的：两臂要共用同一份基础结构，
     * 就靠"预热一次 → 复制缓存文件 → 两臂各自从命中起步"。
     */
    // **命中要"用热"**：Map.set 一个已存在的键不会挪位置，重新 set 一遍
    // 才能让它排到末尾（插入序 = 使用序）——否则热点会话会先被淘汰掉。
    cache.delete(key)
    cache.set(key, hit)
    if (canServeCached(hit.meta, turns.length)) {
      memo.set(body.sessionId, { turns, result: hit })
      return { status: 200, body: { ok: true, structure: hit.state, roots: hit.roots, meta: hit.meta, cached: true } }
    }
    /**
     * **命中但请求更长 ⇒ 不能直接回**（见 `canServeCached`）。
     *
     * 把"请求的前 N 条"当作旧结构覆盖的那批回合喂给 `memo`，下面那条增量路就接上了。
     * 这个假设成立的原因：缓存键里带 `contentHash`（面板送的是随内容变化的指纹），
     * 同一个键下早期回合的内容就是同一批；`isPrefixExtension` / `applyIncrement`
     * 仍然守着"已有结构一个都不动"。
     */
    const coveredTurns = turns.slice(0, Math.max(0, Math.min(hit.meta?.turnsCovered ?? 0, turns.length)))
    memo.set(body.sessionId, { turns: coveredTurns, result: hit })
    void deps.log?.(
      `缓存命中但请求更长（缓存覆盖 ${hit.meta?.turnsCovered ?? '?'} 条 / 请求 ${turns.length} 条）⇒ 走增量`,
    )
  }
  if (inflight.has(key)) {
    try {
      const shared = (await inflight.get(key)) as StructureResult
      return { status: 200, body: { ok: true, structure: shared.state, roots: shared.roots, meta: shared.meta, shared: true } }
    } catch (error) {
      return { status: 200, body: { ok: false, error: (error as Error).message } }
    }
  }
  if (deps.llm?.stream === undefined) return { status: 200, body: { ok: false, error: '宿主没有 llm 能力' } }

  /**
   * **增量归属**：同一会话、回合是前缀延长 ⇒ 只把多出来的那些接上已有结构。
   *
   * 省多少是量出来的：377 回合那场全量 33 次调用 / 41.7 秒，而"再多一个回合"只需
   * **1 次调用**（1 批）。
   *
   * 两条硬约束（落在 `isPrefixExtension` / `applyIncrement` 里）：
   * 1. 前缀逐字相同——早期回合被压缩改写就回退全量，不在旧树上叠新枝；
   * 2. 已有结构的 id / 标题 / 父子关系**一个都不动**——既防结构抖动，也防把用户
   *    手动改过的落点冲掉。
   *
   * 增量**不跑**判整理与根裁定：那两段的职责就是重排（合并/改名/建项目节点），
   * 与"已有结构不许重排"直接冲突。
   */
  const remembered = memo.get(body.sessionId)
  if (remembered !== undefined && isPrefixExtension(remembered.turns, turns)) {
    const fresh = turns.slice(remembered.turns.length)
    const controller2 = new AbortController()
    const abortTimer2 = setTimeout(() => controller2.abort(), STRUCTURE_TIMEOUT_MS)
    let raceTimer2: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        incrementStructure({
          previous: remembered.result,
          fresh,
          turns,
          llm: deps.llm,
          route: deps.route,
          sessionId: body.sessionId,
          chunk,
          signal: controller2.signal,
          log: deps.log,
        }),
        new Promise<never>((_, reject) => {
          raceTimer2 = setTimeout(() => reject(new Error(`增量结构超时（${STRUCTURE_TIMEOUT_MS}ms）`)), STRUCTURE_TIMEOUT_MS)
        }),
      ])
      clearTimeout(abortTimer2)
      clearTimeout(raceTimer2)
      void deps.log?.(`增量归属完成：+${fresh.length} 回合 → 节点 ${Object.keys(result.state.nodes).length}`)
      cache.set(key, result)
      void saveStructureCache(
      pruneStructureCache(cache, { maxTotal: STRUCTURE_CACHE_MAX }),
      STRUCTURE_CACHE_VERSION,
      STRUCTURE_CACHE_MAX,
    )
      memo.set(body.sessionId, { turns, result })
      return { status: 200, body: { ok: true, structure: result.state, roots: result.roots, meta: result.meta } }
    } catch (error) {
      clearTimeout(abortTimer2)
      clearTimeout(raceTimer2)
      // **增量失败就回退全量**（往下继续走）：失败不缓存，也不让面板停在这一档。
      void deps.log?.(`增量归属失败，回退全量：${String((error as Error)?.message ?? error).slice(0, 120)}`)
    }
  }

  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), STRUCTURE_TIMEOUT_MS)
  /**
   * race 用的那个定时器**必须也清掉**：只在 race 里 `setTimeout` 会留下一个
   * 十分钟的挂起定时器，进程退不出去（离线测试里表现为"跑完卡住"，实测踩到）。
   */
  let raceTimer: ReturnType<typeof setTimeout> | undefined
  const run = runStructurePipeline({
    turns,
    llm: deps.llm,
    route: deps.route,
    sessionId: body.sessionId,
    firstWindow,
    chunk,
    signal: controller.signal,
    log: deps.log,
  })
  inflight.set(key, run)
  try {
    // **硬超时**：llm.stream 不理会 abort 时，面板会永远停在"正在算…"
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(() => reject(new Error(`结构计算超时（${STRUCTURE_TIMEOUT_MS}ms）`)), STRUCTURE_TIMEOUT_MS)
      }),
    ])
    cache.set(key, result)
    void saveStructureCache(
      pruneStructureCache(cache, { maxTotal: STRUCTURE_CACHE_MAX }),
      STRUCTURE_CACHE_VERSION,
      STRUCTURE_CACHE_MAX,
    )
    // **全量那一次也要记**：下一次请求才有东西可以"接上去"。
    memo.set(body.sessionId, { turns, result })
    return { status: 200, body: { ok: true, structure: result.state, roots: result.roots, meta: result.meta } }
  } catch (error) {
    return { status: 200, body: { ok: false, error: (error as Error).message } }
  } finally {
    clearTimeout(abortTimer)
    if (raceTimer !== undefined) clearTimeout(raceTimer)
    inflight.delete(key)
  }
}

/** 结构计算的整体上限。139 回合实测 12 次调用、约一分钟量级，留足余量。 */
export const STRUCTURE_TIMEOUT_MS = 600_000

function routeOf(context: any): Route {
  const configured = context.get?.('agentDefaultModel')
  const selection = configured?.selection ?? configured?.current ?? configured?.get?.()
  const provider = selection?.provider ?? selection?.model?.provider
  const model = selection?.model?.model ?? selection?.model
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

/** 注册到宿主（写法与 `semanticUnit.ts` 一致：直接调 `register`，不包 effect）。 */
export function registerTaskStructure(ctx: unknown): void {
  const context = ctx as { get?: (name: string) => unknown }
  const connection = context.get?.('connection') as
    | { fetch?: { register?: (options: Record<string, unknown>) => unknown } }
    | undefined
  if (connection?.fetch?.register === undefined) return
  connection.fetch.register({
    path: STRUCTURE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      /**
       * **兜一层，永远回 JSON**：handler 里任何未捕获的异常（读盘、拼装、模型通道…）
       * 以前会让 webserver 回一个**非 JSON** 响应，而面板直接 `response.json()` ⇒
       * 使用者看到的是浏览器引擎的报错原文（实测："JSON.parse: unexpected keyword at line 1
       * column 1 of the JSON data"）。这里把异常变成一句人话 + `ok:false`。
       */
      let result: { status: number; body: unknown }
      try {
        result = await handleStructureRequest(request as unknown as { json: () => Promise<unknown> }, {
          llm: context.get?.('llm') as StreamLike | undefined,
          route: routeOf(context),
          log: (line) => console.log('[intent-view] ' + line),
        })
      } catch (error) {
        const detail = String((error as Error)?.message ?? error).slice(0, 200)
        console.log('[intent-view] 结构请求内部异常：' + detail)
        result = { status: 200, body: { ok: false, error: `宿主内部异常：${detail}` } }
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
}

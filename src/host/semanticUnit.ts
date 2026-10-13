/**
 * 语义判定的**异步宿主单元**——A+C 的那条缝。
 *
 * ## 为什么结论**没有**落进日志（一个查证过的死路）
 *
 * 我原本的设计是官方 `dsh-session-title-llm` 那一套：把结论 append 成一条
 * 会话事件，再由 `intentProjection` 的纯 fold 折叠——日志当媒介，重放可复现。
 *
 * **这条路在这个构建里走不通**，查证如下：
 *
 * - 第三方事件类型不在 `KNOWN_SESSION_EVENT_TYPES` 里（那张表是
 *   `scripts/gen-persistence-catalog.ts` 生成的，**只含仓内类型**）；
 * - 读取端对"不认识的类型"的容忍**只对 `ignorable: true` 开放**
 *   （`dsh-session` 原文：*"a reader meeting an unrecognized type without this
 *   marker MUST refuse to reconstruct the session"*）；
 * - 而 `Session.append` 造事件时**根本不写 `ignorable`**
 *   （它只放 `type/seq/time/data` 加表面积元数据），**本构建里没有任何写入方
 *   产出过这个字段**。
 *
 * ⇒ 我们自己 append 一条自定义事件，就会写出一条**别的构建读不动的日志**。
 * 这台机器上 `~/.dsh` 是多个 profile 共用的（3080 与 3098 都读同一批会话），
 * 那等于让 3080 **拒绝加载**这个会话——正是本项目刚吃过的 `seq gap` 那一类
 * 不可挽回的故障。**所以不做。**
 *
 * ## 于是实际形状
 *
 * - 结论**不持久化进会话**，由这条 HTTP 路由直接回给浏览器；
 * - **C（按需）**：面板打开且发现 `contentHash` 与本地缓存的不一致时才请求；
 * - **A（一会话一次）**：一次请求带上**材料里那些节点 + 选中的待判回合**，
 *   一次模型调用判完；
 * - **宿主侧按指纹缓存**：同一次内容在进程内只算一次（面板反复开关不重复花钱）；
 * - 浏览器把结果按 `会话+指纹` 存在 localStorage，重开面板不重新请求。
 *
 * 代价要说清楚：**这份结论不在日志里，所以换一台机器/清空浏览器缓存就没了**，
 * 而面板的其余部分（分组、转向、压缩点）都在投影里、可重放。这个不对称是
 * 上面的构建缺口造成的，不是设计偏好。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadTurnCache, saveTurnCache, type StoredVerdict } from './semanticTurnStore.js'
import {
  SEMANTIC_SYSTEM,
  VOTES,
  batchTokenBudget,
  majorityVerdicts,
  parseVerdicts,
  planBatches,
  semanticPrompt,
  semanticTurnKey,
  SEMANTIC_JUDGE_VERSION,
} from '../shared/semantic.js'
import { createLimiter } from '../shared/concurrency.js'

/** 路由路径。浏览器侧引用同一个常量（打包时各在自己半边）。 */
export const SEMANTIC_PATH = '/api/intent.semantic'

/** 一次判定的超时。超过就当作没判成。 */
const TIMEOUT_MS = 45_000

/**
 * **并发数**：`DSH_INTENT_SEMANTIC_CONCURRENCY` 可覆盖（1 = 回到纯串行）。
 *
 * 默认 3：批与批、票与票之间没有依赖，并发只是把"等着"叠起来。上限压到 8 是因为
 * 上游在密集连打时会偶发空回复（实测过"一次 200 条那批里 170 票是空流"），
 * 并发越高越容易撞上——所以默认保守，要更快再往上调。
 */
export function semanticConcurrency(): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const raw = env?.DSH_INTENT_SEMANTIC_CONCURRENCY
  const fallback = 3
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(8, Math.floor(parsed))
}

/**
 * **整场判定的时限**：按材料条数给，而不是一个固定值。
 *
 * 固定 50 秒在"识别效果优先"之后不够用了：一次判 200 条 = 17 批 × 3 票 = 51 次调用，
 * 每次约 1–2 秒 ⇒ 50–100 秒，于是**整场被判超时**、一条结论都拿不到（实测
 * `status: timeout`）。而这一次性的全量判完会进逐回合缓存，之后都是增量。
 *
 * 所以按条数给：`60 秒 + 2 秒/条`，上限 15 分钟（防呆）。
 */
function judgeDeadline(turns: number): number {
  return Math.min(15 * 60_000, 60_000 + 2_000 * Math.max(1, turns))
}
/** 一次请求最多判多少条（分批之后每批更小，见 `planBatches`）。 */
const MAX_TURNS = 200
/** 材料里最多几个任务节点。与 `shared/semantic.ts` 的 `MATERIAL_MAX_TASKS` 同值。
 * 使用者裁定"识别效果优先、成本次要"之后从 60 放宽到 200。 */
const MAX_TASKS = 200

/**
 * 注册这条路由。
 *
 * @param ctx - 宿主上下文（需要 `llm` / `sessions` / `sessionProjections` / `connection`）。
 */
export function registerSemanticUnit(ctx: unknown): void {
  const context = ctx as {
    get(name: string): any
    effect(callback: () => (() => void) | void, label: string): void
  }
  const connection = context.get('connection')
  if (connection?.fetch?.register === undefined) return

  /** 进程内缓存：整份材料指纹 → 结论。什么都没变时一个 token 都不花。 */
  const cache = new Map()
  /**
   * **逐回合缓存**：`semanticTurnKey` → 那一条的结论。
   *
   * 这是"增量"的关键。整份指纹的缓存只在**完全没变**时有用；会话是活的，
   * 新来一个回合整份指纹就变了——按整份缓存的做法，那时要把 40 条全部重判
   * （实测约 12 次调用）。改成逐回合记账之后，只有**这一条**及其节点材料变了的
   * 回合会被重判，其余原地复用。
   */
  /**
   * 逐回合缓存：**先从磁盘载入**（`~/.dsh/storages/intent-view/semantic-turns.json`）。
   *
   * 为什么落盘：它是"新增回合只判变的那几条"的地基，而进程内存版一重启就清零——
   * 于是每次重启后第一次打开面板都要把整场重判（377 回合那类 100+ 秒、上百次调用）。
   * 载入失败/版本不符都会退化成空表（见 `semanticTurnStore.ts` 的契约）。
   */
  const turnCache = loadTurnCache(SEMANTIC_JUDGE_VERSION) as Map<string, StoredVerdict>
  /** 在飞的调用：会话 id → 指纹。挡并发重复请求。 */
  const inFlight = new Map()

  // **不要再包一层 `context.effect`。** 第一版包了，结果路由**注册完立刻被撤掉**：
  // `connection.fetch` 的 getter 是 `const owner = this.ctx`，而 cordis 的服务
  // tracker 会把 `this.ctx` 绑到**读取它的那个上下文**——我这里的读取上下文是
  // 一次性的，effect 随它一起销毁，路由随之消失，浏览器就拿到 404。
  // 官方 `dsh-session-log-export` 是**直接调** `connection.fetch.register(...)`，
  // 不包 effect——照它来。`register` 自己内部已经用 `owner.effect` 管好了生命周期。
  try {
    connection.fetch.register({
        path: SEMANTIC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let body: { sessionId?: unknown } | undefined
          try {
            body = JSON.parse(await request.text())
          } catch {
            return json({ error: 'body must be JSON' }, 400)
          }
          // **判定材料由浏览器给**（它手里已经有投影值：节点归属 + 逐回合原文与理解）。
          //
          // 为什么不让宿主自己去取：`SessionStore.get` 只认识**这个进程里活着**的
          // 会话，而面板显示的历史会话多半是冷的——第一版就是这么撞上
          // `cold-session` 的（路由没问题，是我取不到会话）。
          // 客户端本来就有这份数据，由它送过来最直接。
          //
          // 代价说清楚：**这要求信任客户端输入**。对一个本地 UI 来说可以接受，
          // 所以这里只做形状与长度校验（见 `readRequest`）。真要收紧，就得让宿主
          // 用 `sessionProjectionCache.cachedSnapshot(header, …)` 从磁盘读——
          // 那要先拿到 header，属于下一步。
          const request2 = readRequest(body)
          if ('error' in request2) {
            console.log(`[intent-view] 判定材料被拒：${request2.error}`)
            return json({ error: request2.error }, 400)
          }
          const { sessionId, targets } = request2
          // **每次请求都把指纹打出来。** 客户端为什么会发两次，只能靠这个分辨：
          // 指纹相同 → 客户端状态机的问题；指纹不同 → 材料在两帧之间变了。
          // **带指令的条数也要打出来**：判据的参照物是"用户这一回合发布的指令"，
          // 若浏览器还是旧 bundle（没有这一列），这里会是 0——那说明判据退化成了旧口径，
          // 而不是"模型判得不好"。
          const withAsk = targets.turns.filter((t: { ask?: string }) => (t.ask ?? '') !== '').length
          console.log(
            `[intent-view] 收到判定请求 指纹=${targets.hash} 节点=${targets.tasks.length}` +
              ` 条=${targets.turns.length} 带指令=${withAsk}`,
          )


          if (targets.turns.length === 0) return json({ status: 'nothing-to-judge' })

          // 闸 1：指纹命中进程内缓存 —— 一个 token 都不花。
          // **缓存旁路（只为研究）。** 要量"同一份内容重跑 N 次会不会改口"，
          // 必须先绕过缓存——否则第二次起拿到的是上一次的结论，永远一致。
          //
          // 用**环境变量**而不是请求字段：请求字段一旦存在，生产里就可能被
          // 误发（而这个是**要花钱**的）。环境变量不设就永远不会被触发。
          // 用 `globalThis` 取，免得为这一行引入 `@types/node`（宿主半边没有它）。
          const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
            .process?.env
          const bypass = env?.DSH_INTENT_SEMANTIC_NOCACHE === '1'
          const cached = bypass ? undefined : cache.get(targets.hash)
          // ⚠️ **顺序**：`...cached` 里也带着一个 `status: 'computed'`，写在后面会把
          // 这里的 `'cached'` 盖掉 ⇒ 调用方分不清"刚判的"还是"吃缓存的"。
          // 实测代价：研究探针两臂共用一个指纹时看不出自己吃到了缓存，
          // 差一点把"判据没区分力"当成结论。
          if (cached !== undefined) return json({ ...cached, status: 'cached' })

          // 闸 2：同会话只许一个在飞。面板每次打开都会问一次，
          // 不挡就会并发重复调用（同一次内容算三遍，花三份钱）。
          const pending = inFlight.get(sessionId)
          if (pending === targets.hash) return json({ status: 'in-flight' })
          inFlight.set(sessionId, targets.hash)
          try {
            // ① 先按**逐回合**切：哪些能复用、哪些要新判。
            const split = splitByTurnCache(targets.tasks, targets.turns, turnCache)
            if (split.missing.length === 0) {
              console.log(`[intent-view] 逐回合全部命中：复用 ${split.reused.length} 条，不花钱`)
              return json({
                status: 'cached',
                hash: targets.hash,
                verdicts: sortByTurn(split.reused),
                votes: VOTES,
                reused: split.reused.length,
                judged: 0,
              })
            }
            console.log(
              `[intent-view] 增量判定：新判 ${split.missing.length} 条 · 复用 ${split.reused.length} 条`,
            )
            // ② 只判缺的那些（材料照旧带上节点表；`planBatches` 会按批再裁一次）。
            const result = (await Promise.race([
              judge(context, sessionId, { ...targets, turns: split.missing }),
              new Promise<{ status: string }>((resolve) =>
                setTimeout(() => resolve({ status: 'timeout' }), judgeDeadline(targets.turns.length)),
              ),
            ])) as { status: string; verdicts?: any[] }
            console.log('[intent-view] judge 结果:', result.status)
            if (result.status === 'computed' && Array.isArray(result.verdicts)) {
              // ③ 新结论写进逐回合缓存，并与复用的合并成完整答案。
              for (const verdict of result.verdicts) {
                const key = split.keys.get(verdict.turn)
                if (key !== undefined) rememberTurn(turnCache, key, verdict)
              }
              const merged = {
                ...result,
                verdicts: sortByTurn([...split.reused, ...result.verdicts]),
                reused: split.reused.length,
                judged: split.missing.length,
              }
              cache.set(targets.hash, merged)
              // 落盘（尽力而为）：下次宿主重启也能只判增量
              saveTurnCache(turnCache, SEMANTIC_JUDGE_VERSION, TURN_CACHE_MAX)
              return json(merged)
            }
            // 没判成（超时/解析不出）：**把能复用的先还回去**，其余的这次没有结论。
            return json({
              ...result,
              verdicts: sortByTurn(split.reused),
              reused: split.reused.length,
              judged: 0,
            })
          } finally {
            inFlight.delete(sessionId)
          }
        },
    })
  } catch (error) {
    // 注册失败要说出来：否则症状只是"浏览器拿到 404"，而日志里什么都没有。
    console.log('[intent-view] 语义路由注册失败:', String((error as Error)?.message ?? error))
  }
}

/**
 * 逐回合缓存的**上限**：条目很小（回合号 + 布尔 + ≤120 字理由），
 * 但进程是长命的，所以给一个上限并按插入顺序淘汰最旧的（`Map` 保序）。
 */
const TURN_CACHE_MAX = 5000

/** 记一条结论；满了就丢最旧的。 */
export function rememberTurn(
  cache: Map<string, { turn: number; match: boolean; reason: string; votes?: number; total?: number }>,
  key: string,
  verdict: { turn: number; match: boolean; reason: string; votes?: number; total?: number },
): void {
  cache.set(key, verdict)
  while (cache.size > TURN_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 结论按回合号升序（界面按序渲染）。 */
export function sortByTurn<T extends { turn: number }>(verdicts: readonly T[]): T[] {
  return [...verdicts].sort((left, right) => left.turn - right.turn)
}

/**
 * 把材料切成**能复用的**与**要新判的**。
 *
 * 键是 `semanticTurnKey`（共享实现）：只含这一条回合的"指令 + 理解"与**它自己那个
 * 节点的材料行**。所以别的节点改名、别的回合增删都不会让这一条失效。
 *
 * 这是一处**取舍**（写在 `semanticTurnKey` 的注释里）：模型看到的同一批还有别的节点，
 * 严格说结论依赖整批；把整批编进键就等于"任何变化全批失效"，增量也就没了。
 */
export function splitByTurnCache(
  tasks: readonly string[],
  turns: readonly { turn: number; task: number; ask: string; did: string; objective: string }[],
  cache: Map<string, { turn: number; match: boolean; reason: string; votes?: number; total?: number }>,
): {
  reused: { turn: number; match: boolean; reason: string; votes?: number; total?: number }[]
  missing: { turn: number; task: number; ask: string; did: string; objective: string }[]
  keys: Map<number, string>
} {
  const reused = []
  const missing = []
  const keys = new Map<number, string>()
  for (const turn of turns) {
    const key = semanticTurnKey(turn, String(tasks[turn.task - 1] ?? ''))
    keys.set(turn.turn, key)
    const hit = cache.get(key)
    if (hit === undefined) missing.push(turn)
    else reused.push(hit)
  }
  return { reused, missing, keys }
}

/**
 * 校验浏览器送来的判定材料。
 *
 * **只做形状与长度校验**：条数上限、每条长度上限、指纹格式。这不是安全边界
 * （本地 UI、同一台机器），而是**防止一次坏输入把调用撑大**——那会直接变成钱。
 */
function readRequest(body: any): { sessionId: string; targets: any } | { error: string } {
  const sessionId = String(body?.sessionId ?? '')
  const hash = String(body?.hash ?? '')
  /**
   * 材料：**任务节点**（每个节点一行 = 节点名 + 它名下的代表回合）。
   *
   * 兼容一轮旧的 `groups`：容器从"话题组"换成"任务节点"之后，浏览器里可能还挂着
   * 旧 bundle（面板与宿主不同步时），那时它发的仍是 `groups`。把旧字段当"节点名"
   * 收下即可——形状一样，不会崩。
   */
  const tasks = Array.isArray(body?.tasks)
    ? body.tasks.map((item: any) => String(item))
    : Array.isArray(body?.groups)
      ? body.groups.map((item: any) => String(item))
      : []
  const rawTurns = Array.isArray(body?.turns) ? body.turns : []
  if (sessionId === '' || !/^[0-9a-f]{8}-\d+$/.test(hash)) {
    return { error: `指纹形状不对（要 8 位十六进制 + 序号，收到 ${JSON.stringify(hash)}）` }
  }
  /**
   * **上限超了要说清是哪个上限。**
   *
   * 原来一律回 `bad request`，实测的后果：377 回合那场结构有 225 个节点，
   * 材料按旧口径把所有节点都塞进 `tasks` ⇒ 被这里拒掉 ⇒ **面板上的语义核查整块不跑**，
   * 而界面只显示"bad request"，看起来像路由坏了。现在材料侧已经按 60 收窄
   * （`shared/semantic.ts` 的 `semanticMaterial`），这里仍要报出**具体**原因，
   * 因为下一个人遇到的可能是另一种超限。
   */
  if (tasks.length === 0) return { error: '材料里没有任务节点' }
  if (tasks.length > MAX_TASKS) return { error: `任务节点 ${tasks.length} 个，超过上限 ${MAX_TASKS}` }
  if (rawTurns.length === 0) return { error: '材料里没有待判回合' }
  if (rawTurns.length > MAX_TURNS) return { error: `待判回合 ${rawTurns.length} 条，超过上限 ${MAX_TURNS}` }
  const turns: { turn: number; task: number; ask: string; did: string; objective: string }[] = []
  for (const item of rawTurns) {
    const turn = Number(item?.turn)
    // `task` 是新的；`group` 是旧 bundle 的写法，一并收下
    const task = Number(item?.task ?? item?.group)
    /**
     * 待判的是 **agent 当时的理解**：新字段叫 `objective`，旧 bundle 发的是 `text`。
     * `ask`（用户这一回合发布的指令）是判据的**参照物**——旧 bundle 没有它，
     * 那时按空串处理（提示词里写成"（这一回合用户没有文字指令）"），
     * 判据会退化成旧口径，但不会崩。
     */
    const objective = String(item?.objective ?? item?.text ?? '')
    const ask = String(item?.ask ?? '')
    /** **agent 实际做了什么**（回复正文摘要）。旧 bundle 没有这一列 ⇒ 空串。 */
    const did = String(item?.did ?? '')
    if (!Number.isInteger(turn) || turn < 1) return { error: `回合号不合法：${JSON.stringify(item?.turn)}` }
    if (!Number.isInteger(task) || task < 1 || task > tasks.length) {
      return { error: `回合 ${turn} 的节点号 ${JSON.stringify(task)} 不在 1–${tasks.length}` }
    }
    // **可判文本**：回复摘要或理解，有一个就能判（两个都没有才拒）
    if (objective.length > 400 || did.length > 400) return { error: `回合 ${turn} 的文本过长` }
    if (objective === '' && did === '') return { error: `回合 ${turn} 既没有 agent 回复也没有理解，无从判起` }
    if (ask.length > 400) return { error: `回合 ${turn} 的用户指令过长` }
    turns.push({ turn, task, ask, did, objective })
  }
  for (const task of tasks) if (task.length > 400) return { error: '任务节点材料过长' }
  return { sessionId, targets: { hash, tasks, turns } }
}

/**
 * 一次模型调用。**失败一律当成"这次没判成"**，不让外部服务的抖动变成界面故障。
 *
 * **导出是为了离线断言**：并发改造（票 × 批）必须能证明"调用数不变、结论不变、
 * 在飞数不超过上限"，那只能拿一个假 llm 真跑一遍。
 */
export async function judge(context: any, sessionId: string, targets: any) {
  const llm = context.get('llm')
  console.log('[intent-view] judge: llm =', typeof llm, '· stream =', typeof llm?.stream)
  if (llm?.stream === undefined) return { status: 'no-llm' }
  const route = routeOf(context)
  console.log('[intent-view] judge: route =', JSON.stringify(route))
  if (route === undefined) return { status: 'no-route' }

  // **分批判。** 一次判 40 条时实测 10 次调用全部解析出 0 条——输出被
  // `maxTokens` 截断，JSON 不完整。分批之后每批的输出量有界（见 `BATCH_TURNS`）。
  // **分批判、每批判 VOTES 票。** 两件事各治一个病：
  //   分批 —— 一次判 40 条时输出被 `maxTokens` 截断，JSON 不完整、解析出 0 条；
  //  多票 —— 单票实测 18% 的条目会在重跑时翻面（温度 0 也一样）。
  const batches = planBatches(targets.tasks, targets.turns)
  const verdicts: { turn: number; match: boolean; reason: string; votes: number; total: number }[] = []
  const calls: number[] = []
  /**
   * ⚠️ **超时必须"每次调用一个"，不能整场共用一个 AbortController。**
   *
   * 原先在 `judge` 开头建一次、`setTimeout(TIMEOUT_MS)` 一次，然后被所有批次、所有票
   * 共用。实测后果：一场 200 条的判定要跑 ~45 秒，计时器一到，**后面每一次调用都立刻
   * 被自己 abort**，回来的块是
   * `{"type":"finish","reason":{"kind":"aborted","failure":{"message":"DeepSeek request
   * aborted by caller","code":"ABORTED"}}}`——不报错、不抛异常，只是**那些回合从此没有
   * 结论**（200 条里只有前 84 条拿到判定，其余静默消失）。
   *
   * 这直接把"识别效果"的读数毁掉：能拿到结论的只有最早那几批，按它们算出来的任何比例
   * 都是**有偏**的。现在每次调用现建一个（见 `streamOnce`），整场不再有总时限——
   * 上限由调用方那层 `TIMEOUT_MS + 5s` 的赛跑兜着。
   */
  const streamOnce = (batch: { tasks: string[]; turns: any[] }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const inner = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SEMANTIC_SYSTEM,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: semanticPrompt(batch.tasks, batch.turns) }],
          source: { kind: 'plugin', plugin: 'dsh-intent-view' },
        }),
      ],
      reasoningEffort: 'off',
      temperature: 0,
      maxTokens: batchTokenBudget(batch.turns.length),
      sessionId,
      signal: controller.signal,
    })
    return (async function* () {
      try {
        for await (const chunk of inner) yield chunk
      } finally {
        clearTimeout(timer)
      }
    })()
  }
  try {
    /**
     * 判一批；**若拿回来的条数少于这批的回合数，就把这批拆半再判**（只拆一层）。
     *
     * 为什么需要它：输出被 `maxTokens` 截断时 JSON 不全 ⇒ 整批丢掉，而症状只是
     * "这些回合没有标记"。实测一次 200 条里丢了 116 条（84/200 拿到结论）。
     * 拆半之后每批的输出预算翻倍（`batchTokenBudget` 按条数给），基本能收回。
     */
    const judgeBatch = async (batch: { tasks: string[]; turns: any[] }, depth = 0): Promise<any[]> => {
      const got = await judgeOnce(batch)
      if (got.length >= batch.turns.length || batch.turns.length <= 1 || depth >= 2) return got
      const half = Math.ceil(batch.turns.length / 2)
      console.log(`[intent-view] judge: 一批 ${batch.turns.length} 条只拿回 ${got.length} 条 ⇒ 拆半重判`)
      // 拆半之后**任务编号要重算**：提示词里的"节点 N"是本批内部的编号，
      // 直接切一半会让后半批引用到不存在的节点号（模型只能瞎猜）。
      const renumber = (list: any[]) => planBatches(
        // planBatches 只认全局 task 编号 ⇒ 先把本批的 tasks 展开成"全局表"再切
        batch.tasks,
        list.map((t: any) => ({ ...t, task: Number(t.task) })),
        Math.max(1, list.length),
      )[0] ?? { tasks: batch.tasks, turns: list }
      const rebuilt = (list: any[]) => {
        const batchLocal = renumber(list)
        return { tasks: batchLocal.tasks, turns: batchLocal.turns }
      }
      const left = await judgeBatch(rebuilt(batch.turns.slice(0, half)), depth + 1)
      const right = await judgeBatch(rebuilt(batch.turns.slice(half)), depth + 1)
      return [...left, ...right]
    }
    /**
     * **并发闸门放在叶子层**（真正的模型调用）：`semanticConcurrency()` 个在飞。
     *
     * 不在"批/票"那层各自限流——两层会乘起来（3 批 × 3 票 = 9，实测过一次），
     * 而"外层占名额、内层等名额"会死锁。放叶子层：总在飞数恒等于上限。
     */
    const limited = createLimiter(semanticConcurrency())
    /** 收集一次调用的原文（块 → 文本）。空流重试各占一个名额。 */
    const collectOnce = async (batch: { tasks: string[]; turns: any[] }) =>
      limited(async () => {
        const assembler = new BlockAssembler()
        let chunks = 0
        /** 空流时把那唯一一块的原文留下来：**分不清是"没内容"还是"报错"就查不下去**。 */
        let firstChunk: unknown = undefined
        for await (const chunk of streamOnce(batch)) {
          chunks += 1
          if (chunks === 1) firstChunk = chunk
          assembler.push(chunk)
        }
        const blocks = assembler.blocks()
        return {
          chunks,
          firstChunk,
          raw: blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
          types: blocks.map((b: any) => b.type).join(','),
        }
      })

    /**
     * 一批的 VOTES 票**并发**跑（票与票之间没有依赖：各自一份 prompt、各自解析）。
     * `Promise.all` 按输入顺序回填 ⇒ `rounds` 的顺序仍是票序（同票数时的 tie-break 依赖它）。
     */
    const judgeOnce = async (batch: { tasks: string[]; turns: any[] }): Promise<any[]> => {
      const rounds: { turn: number; match: boolean; reason: string }[][] = []
      const voteResults = await Promise.all(
        Array.from({ length: VOTES }, async () => {
          let collected = await collectOnce(batch)
          /**
           * **空流重试一次**：实测 200 条那批里 170 票是"流里只有 1 块、块列表为空、
           * 正文 0 字"——一次性连打几十次调用时，上游会偶发这种空回复。
           * 不重试的后果不是报错，而是**静默丢掉那些回合的结论**（界面上只是没标记）。
           */
          if (collected.raw === '' && collected.chunks <= 2) {
            console.log('[intent-view] 空回复，重试一次；那一块：', JSON.stringify(collected.firstChunk).slice(0, 200))
            collected = await collectOnce(batch)
          }
          const got = parseVerdicts(collected.raw, batch.turns.map((turn: { turn: number }) => turn.turn))
          // **一票解析不出来不算零票**：把它丢掉，剩下的票照样取多数。
          // （整批全丢才判 unparsable——那时是真的没拿到东西。）
          if (got.length > 0) {
            /**
             * **诊断开关**（`DSH_INTENT_SEMANTIC_DUMP=1`）：把第一批的原文打出来。
             * 合规率 0/12 这种问题，不看原文只能猜（模型没写？字段名不同？被截断？）。
             */
            const dump = (globalThis as { process?: { env?: Record<string, string | undefined> } })
              .process?.env?.DSH_INTENT_SEMANTIC_DUMP
            if (dump === '1' && batch.turns.length > 0) {
              console.log('[intent-view] 原文样本（前 400 字）：', collected.raw.slice(0, 400))
            }
          } else {
            /**
             * 空文本要说清"空到什么程度"：只说"无法解析"的话，**分不清**是
             * 模型没回正文（流里一个 text 块都没有）还是回了但 JSON 坏了。
             * 实测一次 200 条里 116 条拿不到结论，而日志里那条理由后面是**空白**——
             * 我照着"截断"去调输出预算，方向错了。所以这里把块的形状也打出来。
             */
            console.log(
              `[intent-view] 某票拿不到判定：chunks=${collected.chunks} · 块=[${collected.types}] · ` +
                `正文 ${collected.raw.length} 字` +
                (collected.raw.length > 0 ? ` · 前 120：${collected.raw.slice(0, 120)}` : '（流里没有正文块）'),
            )
          }
          return got
        }),
      )
      for (const got of voteResults) if (got.length > 0) rounds.push(got)
      if (rounds.length === 0) return []
      const merged = majorityVerdicts(rounds)
      calls.push(rounds.length)
      const mismatches = merged.filter((item) => item.match === false).length
      /**
       * **合规率要报出来**：`want`/`got`（"用户要什么"vs"agent 理解成什么"）是判据的抓手，
       * 也是人核对时最省事的两列。只写"请先复述"而不量它，结果就是**实测 0/30 一条都没写**
       * 而没人发现。这里按批报，低于一半就点名。
       */
      const withBoth = merged.filter((item: any) => (item.want ?? '') !== '' && (item.got ?? '') !== '').length
      /**
       * **第三问也要报合规率**：实测它在"材料单调重复"的一批里会**整批不写**
       * （12 条 0 条给 parent），而界面上只是"这些回合没有 ↔较远"——看不出来是漏了。
       * 与 `want/got` 同一个理由：不量它，就等于没有这条判据。
       */
      const withParent = merged.filter((item: any) => item.parent !== undefined).length
      console.log(
        `[intent-view] judge: ${batch.turns.length} 条 → ${rounds.length} 票有效 · ` +
          `多数票判"偏离" ${mismatches}/${merged.length} · want/got 合规 ${withBoth}/${merged.length}` +
          ` · 第三问合规 ${withParent}/${merged.length}` +
          (withBoth * 2 < merged.length ? '  ⚠️ 模型没按格式复述' : '') +
          (withParent * 2 < merged.length ? '  ⚠️ 第三问大片缺失' : ''),
      )
      return merged
    }

    /**
     * **批次也并发**（批与批之间没有依赖：每批自带任务编号与材料）。
     * 闸门在叶子层，所以这里的 `Promise.all` 不会把在飞数放大。
     */
    const parts = await Promise.all(batches.map((batch) => judgeBatch(batch)))
    for (const part of parts) verdicts.push(...part)
    if (verdicts.length === 0) return { status: 'unparsable' }
    return {
      status: 'computed',
      hash: targets.hash,
      model: `${route.provider}/${route.model}`,
      at: Date.now(),
      verdicts,
      votes: VOTES,
      // 实际用了多少票（有票被丢弃时会小于 VOTES）——**报账用**
      counted: calls,
    }
  } catch (error) {
    console.log('[intent-view] judge: 抛错 →', String((error as Error)?.message ?? error).slice(0, 200))
    return { status: 'failed', detail: String((error as Error)?.message ?? error).slice(0, 200) }
  } finally {
    // 整场不再持有计时器：每次调用自带一个（见 `streamOnce`），流结束就清掉
  }
}

/**
 * 用哪个模型判。
 *
 * 优先 `agentDefaultModel`（用户在设置里选的那个默认模型）——它是宿主侧的
 * 权威来源，不依赖任何会话是否活着。取不到就退到配置里的兜底。
 */
function routeOf(context: any): { provider: string; model: string } | undefined {
  const configured = context.get('agentDefaultModel')
  const selection = configured?.selection ?? configured?.current ?? configured?.get?.()
  const provider = selection?.provider ?? selection?.model?.provider
  const model = selection?.model?.model ?? selection?.model
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

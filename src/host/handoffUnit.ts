/**
 * **交接摘要的模型精炼**（阶段 2）：把面板那份确定性草稿交给模型，换成更好读的一版。
 *
 * ## 为什么是"精炼草稿"而不是"从头总结"
 *
 * 使用者的两条要求同时压在这上面：**降低新会话的学习难度** + **保证了解程度**。
 * 草稿（`shared/handoff.ts`）已经保证了"事实不漏"（来源、快照声明、结构层级、逐回合要点），
 * 模型这一步只做**重写**：把散点整理成"目标 / 已定结论 / 关键约束 / 未决 / 建议第一步"。
 * 于是：
 * - 材料**就是草稿本身**（不必再把逐回合材料送一遍，token 省一半）；
 * - 提示词明确"不许新增事实、枝名层级必须保留"——它写跑偏时，用户手上还有草稿可退回；
 * - **失败一律软降级**：面板保留草稿，只把那句原因显示出来（抄"这次没精炼成"的账）。
 *
 * ## 与别的单元一致的几处约定
 *
 * - 路径常量在宿主与浏览器各写一份（`SEMANTIC_PATH` 就是这么做的，见 `IntentTab.ts`）；
 * - `reasoningEffort: 'off'` + `temperature: 0`：这是重写活，不是思考活（实测开思考慢一个量级）；
 * - 任何异常都回 `{ok:false, error}`，HTTP 仍是 200——面板据此回退，不把它当崩溃。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

export const HANDOFF_PATH = '/api/intent.handoff'

/** 精炼用的系统提示。⚠️ 不许出现反引号——它会被包进模板串里（本项目踩过 6 次）。 */
const HANDOFF_SYSTEM = [
  '你在把一份"会话交接摘要"改写得更适合交给一个**全新的会话**去接手。',
  '输入是一份已经整理好的草稿（含来源、任务结构、逐回合要点）。',
  '你的任务只有一条：**重写成更好读的一版**，不许新增事实、不许删掉枝名与层级。',
  '输出 markdown，段落顺序固定：',
  '1. 一句话说明这是从哪段会话摘出来的快照；',
  '2. 目标：这件事要达成什么；',
  '3. 已定结论：已经确定的事实/决定（逐条，尽量保留原话里的关键限定）；',
  '4. 关键约束：不能违反的前提（技术、数据、口径、时间）；',
  '5. 未决：还没定或还有分歧的点；',
  '6. 建议第一步：接手方应当先做什么（一句话）。',
  '如果草稿里带了任务结构（缩进列表），把它原样放进"目标"之后的一节，保留缩进。',
  '只输出正文，不要解释你做了什么。',
].join('\n')

/** 材料上限：草稿超长就截断（面板会显示字数，用户看得见自己给了多少）。 */
const MAX_DRAFT_CHARS = 24_000
const TIMEOUT_MS = 60_000

export interface HandoffDeps {
  llm?: { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined
  route?: { provider: string; model: string } | undefined
  timeoutMs?: number
}

interface HandoffBody {
  sessionId?: unknown
  draft?: unknown
  withTitles?: unknown
}

/** 一次调用：与别的单元同一套块协议（block-start → text-delta* → block-end）。 */
async function callModel(
  llm: NonNullable<HandoffDeps['llm']>,
  route: { provider: string; model: string },
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream?.({
      provider: route.provider,
      model: route.model,
      system: HANDOFF_SYSTEM,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-intent-view' },
        }),
      ],
      // 重写活：关思考（与结构流水线同一个理由：开思考慢一个量级）
      reasoningEffort: 'off',
      temperature: 0,
      maxTokens: 2000,
      sessionId,
      signal: controller.signal,
    }) as AsyncIterable<never>) {
      assembler.push(chunk)
    }
    return assembler
      .blocks()
      .map((block) => (block.type === 'text' ? (block as { text?: string }).text ?? '' : ''))
      .join('')
  } finally {
    clearTimeout(timer)
  }
}

/** 处理一次精炼请求。**逻辑与路由分开**，这样它能被离线测（注入假 llm）。 */
export async function handleHandoffRequest(
  request: { json: () => Promise<unknown> },
  deps: HandoffDeps,
): Promise<{ status: number; body: unknown }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } }
  }
  const body = (raw ?? {}) as HandoffBody
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const draft = typeof body.draft === 'string' ? body.draft : ''
  if (sessionId === '') return { status: 400, body: { ok: false, error: 'sessionId 缺失' } }
  if (draft.trim() === '') return { status: 400, body: { ok: false, error: '草稿是空的' } }
  if (deps.llm?.stream === undefined) return { status: 200, body: { ok: false, error: '宿主没有 llm 能力' } }
  const route = deps.route ?? { provider: 'deepseek-official', model: 'deepseek-flash' }
  const started = Date.now()
  try {
    const text = await callModel(
      deps.llm,
      route,
      `下面是草稿（可能被截断到 ${MAX_DRAFT_CHARS} 字）：\n\n${draft.slice(0, MAX_DRAFT_CHARS)}`,
      sessionId,
      deps.timeoutMs ?? TIMEOUT_MS,
    )
    if (text.trim() === '') return { status: 200, body: { ok: false, error: '模型回了空文本' } }
    return {
      status: 200,
      body: { ok: true, text, meta: { elapsedMs: Date.now() - started, model: `${route.provider}/${route.model}` } },
    }
  } catch (error) {
    // **软降级**：面板据此保留草稿（使用者裁定：失败也不该丢东西）
    return { status: 200, body: { ok: false, error: String((error as Error)?.message ?? error).slice(0, 160) } }
  }
}

/**
 * 注册路由。与别的单元一样走 `connection.fetch.register`（官方插件同款用法）。
 * 缺 `connection`/`fetch` 时**静默不注册**——面板那边会退化成"只有草稿"。
 */
export function registerHandoffUnit(ctx: unknown): void {
  const connection = (ctx as { get?: (name: string) => unknown })?.get?.('connection') as
    | { fetch?: { register?: (options: unknown) => unknown } }
    | undefined
  if (connection?.fetch?.register === undefined) return
  const fetchRoute = (): { provider: string; model: string } => {
    const configured = (ctx as { get?: (name: string) => unknown }).get?.('agentDefaultModel') as
      | { selection?: { provider?: string; model?: unknown }; current?: unknown }
      | undefined
    const selection =
      configured?.selection ?? (configured?.current as { provider?: string; model?: unknown } | undefined)
    const provider = selection?.provider
    const model = (selection?.model as { model?: string } | undefined)?.model ?? (selection?.model as unknown as string)
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
    return { provider: 'deepseek-official', model: 'deepseek-flash' }
  }
  // 注册形状照 `semanticUnit` 那一份（`methods` / `requestBody` 都要有）
  try {
    connection.fetch.register({
      path: HANDOFF_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        const result = await handleHandoffRequest(request as unknown as { json: () => Promise<unknown> }, {
          llm: (ctx as { get?: (name: string) => unknown }).get?.('llm') as HandoffDeps['llm'],
          route: fetchRoute(),
        })
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
  } catch (error) {
    // 自己兜住：绝不把失败抛给调用方（那会连累同一个 inject 回调里的其他注册）
    console.error('[intent-view] 交接摘要路由注册失败：', String((error as Error)?.message ?? error).slice(0, 200))
  }
}

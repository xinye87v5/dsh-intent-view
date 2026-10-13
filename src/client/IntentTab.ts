/**
 * 「意图」tab：任务意图如何随回合演变。
 *
 * 数据来自 DSH 客户端的会话投影（`ctx.get('sessions').list` 的每会话
 * `projectionValues`）。实测（52 个会话）：`turnOutline` 有 26 个会话有数据，
 * `goal` **只有 2 个** —— 所以目标是**可选锚点**，不是必需节点。
 *
 * ## 三个模块，导入顺序即依赖深度
 *
 * ```
 * text.ts    字符二元组、摘要、reach 度量      ← 叶子
 * intent.ts  逐回合的连续量、阶段、承接判定     ← 依赖 text
 * ```
 *
 * **顺序不能随便。** 包装脚本把模块内联成单个文件，要求依赖先于使用者出现，
 * 并且**拒绝环**——那是它的正确行为：一个环在内联后是未定义行为。
 * 这条约束踩过两次（`intent ↔ shifts`、以及相对导入顺序），所以记在这里。
 *
 * ## 面板不会替你滚
 *
 * `paneContent` 是 `overflow: hidden`，每个 tab 的内容自己负责滚动。
 * `SCROLL` 见下。
 */

import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useCallback, useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { snippet } from '../shared/intent'
// 判定材料与它的指纹：**唯一实现**在 shared（宿主侧与探针都用同一份）。
// 两边各写一遍的后果实测过两次：指纹不一致会让缓存永远失效（每次重新烧钱）；
// 而材料不按宿主的上限收窄会让整份请求被拒——377 回合那场 225 个节点就是这么当掉的，
// 面板上语义核查整块不跑，越长的会话越不检查。
import { planMaterialRequests, semanticKey, semanticMaterial, shardHash, type SemanticMaterial } from '../shared/semantic'
// 人工覆盖：**持久化在浏览器侧**（使用者裁定：插件的部件内），并且渲染与判定材料共用同一份"生效结构"
import {
  applySessionTitle,
  loadOverrides,
  loadSessionTitle,
  remapEnabled,
  remapOverridesByTitle,
  remapReceipt,
  saveOverrides,
  saveSessionTitle,
} from '../shared/overrideStorage'
// 人工修正**判定标记**：与结构覆盖分开存（键/生命周期/失效条件都不同）
import { applyVerdictOverrides, loadVerdictOverrides, saveVerdictOverrides, type VerdictOverride } from '../shared/verdictStorage'
import { deleteImpact, effectiveStructure, siblingTitleConflict, type TaskGraph } from '../shared/taskGraph'
import type { TaskOverride } from '../shared/taskOverrides'
import {
  pickSession,
  type IntentModel,
  type IntentTurn,
  type PickedSession,
} from './intent'
import { modelFromProjection } from './model'
// 结构树的行结构：直接复用 shared 那份（`treeRows`，与研究工具逐字交叉校验过）
// ⚠️ **不要给被内联的相对模块的导入起别名**：包装器会把 import 行整行丢掉，
// 内联进来的函数仍叫原名，别名就成了未定义标识符（浏览器里报 `taskRenderTree is not defined`）。
// 这条现在由 wrap-client.mjs 直接拒绝（见那里的 RELATIVE_ALIAS 检查）。
import { nestRows, treeRows, type TreeOutline, type Turn as TaskTurn } from '../shared/taskPipeline'
import { handoffDraft, fullySelectedNodes, subtreeTurns, toggleBranch, toggleTurn } from '../shared/handoff'
import { compactionCount, isCompactionTurn, type IntentCompaction } from './compaction'

/**
 * 「意图」tab：任务意图如何随回合演变。
 *
 * ## 读什么
 *
 * 数据来自 DSH 客户端的会话投影（`ctx.get('sessions').list` 的每会话
 * `projectionValues`）。实测（52 个会话）：
 *
 * - `turnOutline` 有 26 个会话有数据 —— 这是载体
 * - `goal` **只有 2 个** —— 所以它是可选锚点，不是必需节点
 *
 * ## 为什么是"脊柱"而不是自由布局的图
 *
 * 这张图的横轴没有别的含义：回合是**顺序**的。把 198 个回合摊进二维平面，
 * 得到的是一团线，而不是更多信息。所以画成一条自上而下的脊柱——
 * 目标在顶，阶段分段，回合挂在脊柱上。
 *
 * 这仍然是图（节点 + 边 + provenance），只是它的布局由数据形状决定，
 * 而不是由渲染器猜。
 *
 * ## 一个必须显示的限制
 *
 * 投影里的文本被截断（prompt 400 / response 120 字符）。所以组内贴合度是
 * **字面重合度**——一个换了措辞讲同一件事的回合会被判低。
 *
 * 界面上低贴合只是**标记**，措辞是"**不贴合**"而不是"偏离"：
 * 后者是这张图无权下的结论。
 */


/**
 * 面板主体的 props —— **本插件自己的最小面**。
 *
 * 原先借的是第三方侧栏（`dsh-better-sidebar`）的 `TabComponentProps`。侧栏那条路已经移除，
 * 那个包**不再是本插件的依赖**（peerDependencies 里也没有它），所以类型层面也不能再引用它：
 * 类型导入虽然在打包时被抹掉，但发布出去的 `.d.ts` 会让使用者的 `tsc` 报"找不到模块"。
 *
 * 主体真正读的只有四个字段，形状在这里定死：
 * - `ctx`：拿 `ctx.get('sessions')` 的会话投影；
 * - `visible`：不可见时省掉请求（主区切走 tab）；
 * - `wide`：主区是宽区，只调版式四个数（内边距/限宽/摘要长度/每节点条数）；
 * - `scope.sessionId`：作用域会话（面板自己有"显示的那个会话"的回落逻辑）。
 */
export interface IntentTabProps {
  ctx?: unknown
  visible?: boolean
  wide?: boolean
  scope?: { sessionId?: string }
}

/**
 * **文本颜色分三档**（使用者："文本颜色也能调整一下吗"）。
 *
 * 之前正文用 `currentColor 78%`、元信息 55%，在浅色主题下都偏虚，行一多就糊成一片。
 * 现在：
 * - `TEXT`：**正文**（会话原文、节点标题以下的内容）——88%，尽量接近主题前景色；
 * - `MUTED`：**元信息**（回合号、区间徽标、计数）——62%，能读但不抢；
 * - `FAINT`：**未判/占位**——40%，让"还没判"自然地退到背景里。
 * 用 `color-mix(currentColor)` 而不是写死颜色，是为了跟随 DSH 的明暗主题。
 */
const TEXT = 'color-mix(in srgb, currentColor 92%, transparent)'
const MUTED = 'color-mix(in srgb, currentColor 74%, transparent)'
const FAINT = 'color-mix(in srgb, currentColor 56%, transparent)'
/**
 * **回合号：红色**（使用者："我想让回合号的颜色变红"）。
 *
 * 为什么要写死色相而不是继续用 `currentColor` 的透明度：**深色主题下前景色本来就浅**，
 * 88% / 62% / 40% 三档混出来几乎分不出（使用者实测说"没多大区别"），
 * 而透明度越低越"糊"。要拉开层次就得用**显式色相**。
 *
 * 红只给"回合号"这一个角色：它是全篇的**锚点**（多处引用 `#12` 这种编号，
 * 扫的时候靠它定位）。问题态仍然用琥珀系（理解偏/越界），失败用 `LOW` + ✕，
 * 三者色相不同，不会混。
 */
const TURN_NO = '#e0574f'
const LOW = '#d9463f'
const ACCENT = '#2e6fd9'

/**
 * 压缩标记的颜色。
 *
 * **刻意不是 `LOW`（红）**：压缩不是错误，也不是价值判断——它是"历史在这里
 * 被截断了"这个事实。用红色会让读者以为出了问题。
 * 琥珀色是"注意这里有件事"，与"好/坏"无关。
 */
const COMPACT = '#c99a3a'
/**
 * **状态行的统一外观**（使用者："面板运行状态要便于区分"）。
 *
 * 四态各有一套边框色 + 淡底 + 前缀符号：未开始（灰 ○）、正在算（琥珀 ◌，与压缩点同色系）、
 * 完成（蓝 ●）、失败（红 ✕）。原先三种状态只有文字不同、框子一模一样，扫一眼分不出来。
 */
function statusLook(kind: 'idle' | 'running' | 'done' | 'failed'): {
  border: string
  background: string
  glyph: string
} {
  const color = kind === 'running' ? COMPACT : kind === 'failed' ? LOW : kind === 'done' ? ACCENT : MUTED
  return {
    border: `1px solid ${color}`,
    background: `color-mix(in srgb, ${color} 7%, transparent)`,
    glyph: kind === 'running' ? '◌' : kind === 'failed' ? '✕' : kind === 'done' ? '●' : '○',
  }
}

/** 逐回合标记的配色：正常淡、有问题用琥珀（与压缩点同色系，都不是"错误"的语义）、未判最淡。 */
/**
 * **人工判定的三个预设**（模块层一份，两处共用）。
 *
 * ⚠️ 字段语义容易读反：`understanding === false` 才是"理解偏"、
 * `inScope === false` 才是"越界"——名字问的是"对不对"，`false` 就是不对。
 * `match` 是两问的合取（唯一规则在共享层，这里只是它的三个取值）。
 *
 * 详情层与批量操作栏都要用；各写一份就是"同一语义两处实现"，
 * 改一处忘一处会让两条入口给出不同的结论。
 */
const VERDICT_PRESETS: { label: string; match: boolean; understanding: boolean; inScope: boolean; hint: string }[] = [
  { label: '✓', match: true, understanding: true, inScope: true, hint: '理解没偏、也没出界（判据认为正常）' },
  { label: '理解偏', match: false, understanding: false, inScope: true, hint: 'agent 把任务理解偏了（行为在界内，但方向不对）' },
  { label: '越界', match: false, understanding: true, inScope: false, hint: '理解没错，但顺手做了该节点对象之外的事' },
]

/**
 * 第三问（归属贴近度）的颜色：与"做得对不对"那三档明显不同色系（青灰），
 * 免得被读成"又一个错误标记"。
 *
 * **用 `currentColor` 派生**（而不是写死 `#7b8fa3`）：写死的颜色在浅色主题下够暗、
 * 在深色主题下偏灰，判断"要不要调亮"这件事只能靠人看。派生之后它跟着主题走，
 * 顺带把"要不要给个更亮的色相"这个问题消掉。
 */
const PARENT_FAR = 'color-mix(in srgb, currentColor 55%, #4a708f)'

const MARK_COLOR: Record<string, string> = {
  ok: 'color-mix(in srgb, currentColor 42%, transparent)',
  understanding: '#b0722a',
  scope: '#a35b1f',
  both: '#8c4a12',
  none: 'color-mix(in srgb, currentColor 34%, transparent)',
}

/**
 * 面板内容的滚动容器样式。
 *
 * **面板自己不会滚。** better-sidebar 的 `paneContent` 是 `overflow: hidden`，
 * 而 `paneTab` 是 `flex-direction: column` 且 `overflow: visible`——
 * 也就是说每个 tab 的**内容自己负责滚动**。
 *
 * 实测过的后果：什么都不设时，内容高 9764px、可视区 965px，**被裁掉且滚不动**。
 *
 * - `flex: '1 1 auto'` + `minHeight: 0` 让它在 flex 列里收缩到可用高度。
 *   `minHeight: 0` 是关键：flex 项的默认 `min-height: auto` 会按内容撑开，
 *   那样 `overflow` 就没有可滚的余地了。
 * - `overflowY: 'auto'` 只在内容真的超高时出现滚动条。
 */
/**
 * **版式的两个档**（步骤④：主区是宽区，侧栏是窄列）。
 *
 * 这套密度（缩进、徽标、40 字回合摘要、每节点最多 6 条）全是为**窄列**调的；
 * 直接放到主区会显得又小又空。这一档只调四个数——**故意不做重排**：
 * 结构树的形状、交互、断言全都不动，观感留给人看（步骤④的约定）。
 */
export interface PanelLayout {
  /** 容器内边距。 */
  padding: string
  /** 宽区限宽并居中（窄列不限，本来就是满宽）。 */
  maxWidth?: number
  /** 回合行里那句原文的截断长度。 */
  snippet: number
  /** 一个节点下最多列几条回合（窄列用；宽区不截断）。 */
  preview: number
  /** 宽区的区间大小（每几个回合折成一行）；0 = 不收区间。 */
  rangeSize: number
}

export function layoutFor(wide: boolean): PanelLayout {
  return wide
    ? // **宽区不截断**：主区 tab 放得下，使用者明确要求"去掉看全部"（2026-10-13）
      { padding: '16px 24px 32px', maxWidth: 1100, snippet: 96, preview: Number.POSITIVE_INFINITY, rangeSize: 10 }
    : // **窄列也用区间**（使用者 2026-10-14："全部按方案 B 的设计展示，不再进入详情才能看到全部"）
      // 之前窄列留着"前 6 条 + 还有 N 个"，于是他那个 26 回合的枝只看到 6 条。
      // 区间大小取 6：一屏能容下的行数比宽区少，区间行本身也要占位。
      { padding: '12px 14px 24px', snippet: 44, preview: Number.POSITIVE_INFINITY, rangeSize: 6 }
}

const SCROLL: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
}

interface SessionsListLike {
  getSnapshot?: () => {
    ids?: string[]
    byId?: Record<string, { projectionValues?: unknown; displayTitle?: string } | undefined>
    current?: string | null
  }
  subscribe?: (listener: () => void) => () => void
}

interface SessionsLike {
  list?: SessionsListLike
}

interface ContextLike {
  get(name: string): unknown
}

/** `buildIntentModel` 接受的投影形状，这里只为让调用点的类型显式。 */
/** 适配器接受的投影形状。 */
type ProjectionLike = Parameters<typeof modelFromProjection>[0]

/**
 * 订阅会话列表，读出当前会话的投影。
 *
 * ## 为什么用 `useSyncExternalStore` 而不是 `useEffect` + `setState`
 *
 * 后者在**渲染期拿不到数据**，所以：
 *
 * - 服务端渲染（以及任何同步渲染）永远只得到空态——这让组件无法在浏览器之外验证，
 *   而"能不能验证"决定了这类接线 bug 是被测出来还是被用户撞出来。
 * - 浏览器里也白多一帧空态。
 *
 * `useSyncExternalStore` 在渲染期读快照，两种环境行为一致。这也正是
 * better-sidebar 自己发布状态用的机制。
 *
 * `getSnapshot` **必须返回稳定引用**，否则 `useSyncExternalStore` 会判定"一直在变"
 * 而无限重渲染。所以这里缓存住上一次的结果：只有当订阅通知到达时才重新取。
 */
function entryCache(
  list: SessionsListLike | undefined,
  sessionId: string | undefined,
): {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { projection: unknown; title: string } | undefined
} {
  let cached: { projection: unknown; title: string } | undefined
  let primed = false
  const read = (): { projection: unknown; title: string } | undefined => {
    if (list?.getSnapshot === undefined || sessionId === undefined) return undefined
    const entry = list.getSnapshot()?.byId?.[sessionId]
    return {
      projection: entry?.projectionValues,
      title: String(entry?.displayTitle ?? ''),
    }
  }
  return {
    subscribe: (listener) => {
      // 订阅到达时作废缓存，下一次读取会重新取。
      const invalidate = (): void => {
        primed = false
        listener()
      }
      return list?.subscribe?.(invalidate) ?? (() => {})
    },
    getSnapshot: () => {
      if (!primed) {
        cached = read()
        primed = true
      }
      return cached
    },
  }
}

/**
 * 语义判定：**按需请求 + 本地缓存**（A+C 里的 C）。
 *
 * ## 为什么不走投影
 *
 * 模型调用是异步的，而投影的 `apply` 必须纯同步；而"结论落成会话事件"那条路
 * 在这个构建里**走不通**（`Session.append` 不写 `ignorable`，写进去会让别的
 * 构建拒绝加载这个会话——详见 `host/semanticUnit.ts` 顶部）。所以这里走
 * **宿主的一条 HTTP 路由**，结论由浏览器按 `会话 + 指纹` 缓存在 localStorage。
 *
 * ## 三道闸在这里的样子
 *
 * - **指纹没变不请求**：`contentHash === cached.hash` 就直接渲染缓存；
 * - **同一个指纹只请求一次**：模块级的 `inFlight` 挡住重复（面板每次重渲染都会走到这里）；
 * - **失败保持原状**：请求失败就把状态记成 `failed` 并**不再自动重试**，
 *   免得一个抖动变成请求风暴。下一次内容变化会自然重试。
 */
/**
 * **读一个 JSON 响应体，读不成给人话**。
 *
 * 为什么需要它：面板原先直接 `await response.json()`，于是当宿主返回**空响应或 HTML**
 * （重启中被切断、内部异常、网关错误页…）时，界面上出现的是**浏览器引擎的报错原文**——
 * 使用者实测到的是 Firefox 的
 * `任务结构：这次没算成（JSON.parse: unexpected keyword at line 1 column 1 of the JSON data）`。
 * 那句话对使用者没有任何信息量，也分不清"该重试"还是"该查日志"。
 */
export async function readJsonBody<T>(response: {
  status?: number
  text: () => Promise<string>
}): Promise<{ data?: T; error?: string }> {
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    return { error: `响应读不出来（连接被中断？）：${String((error as Error)?.message ?? error).slice(0, 120)}` }
  }
  /**
   * **认证失败要单独说**：宿主被重启过之后 token 会换，而**重启前打开的页面**带着旧身份，
   * 于是每个 API 调用都被认证层挡下、回一段纯文本 `unauthorized`。
   * 使用者实测到的那句 `JSON.parse: unexpected keyword at line 1 column 1 …` 里的
   * "keyword" 就是它——原来面板把引擎报错原样端出去，谁也看不出"刷新一下就好"。
   */
  if (response.status === 401 || response.status === 403) {
    return {
      error: `宿主没认出这次请求的身份（${response.status}）——多半是这个页面在宿主重启前就打开了：刷新页面即可`,
    }
  }
  if (text.trim() === '') return { error: '宿主回了空响应（常见原因：宿主正在重启，或请求被中断）——重试一次；反复出现就看宿主日志' }
  try {
    return { data: JSON.parse(text) as T }
  } catch {
    const head = text.trim().slice(0, 60).replace(/\s+/g, ' ')
    return { error: `宿主回的不是 JSON（开头是「${head}」）——多半是宿主内部出错或网关错误页，看宿主日志` }
  }
}

const SEMANTIC_PATH = '/api/intent.semantic'
/** 交接摘要的模型精炼（宿主 `handoffUnit.ts` 里同一份常量）。 */
const HANDOFF_PATH = '/api/intent.handoff'
const STRUCTURE_PATH = '/api/intent.structure'
const SEMANTIC_KEY = 'intent-view:semantic:'

interface SemanticVerdict {
  turn: number
  match: boolean
  reason: string
  /** 支持这个结论的票数（3 票里 2 或 3）。 */
  votes?: number
  /** 实际收到的票数。 */
  total?: number
  /**
   * **两问的原始答案**（`match` 是它们的合取）。
   *
   * `understanding` = 理解对不对；`inScope` = 有没有越界。
   * 界面要能分开说：理解偏了要重说任务，越界了只要挪回界内。
   */
  understanding?: boolean
  inScope?: boolean
  /** 模型列出的"回复里动过的对象"（越界那一问的依据）。 */
  touched?: string[]
  /** **第三问：归属贴近度**（`far` = 离父枝较远 / 顶层枝时=偏出领域）。**不进 match**。 */
  parent?: 'near' | 'far' | 'na'
  parentWhy?: string
}
interface SemanticResult {
  hash: string
  model: string
  at: number
  verdicts: SemanticVerdict[]
  /** 每批判了几票。 */
  votes?: number
  /**
   * 这次**新判**了几条、**复用**了几条（宿主逐回合缓存给的账）。
   *
   * 放进结果里是为了让它可见：增量判定若悄悄退化成全量重判，界面上要看得出
   * ——否则"成本为什么又上去了"只能靠翻宿主日志。
   */
  judged?: number
  reused?: number
  /**
   * **还有几片没回来**（渐进渲染用；`0`/缺省 = 这份是完整的）。
   *
   * 为什么要它：长会话（83 条）要 20 多秒才全部判完，而面板以前**等全部判完才显示**——
   * 于是"已经判好的那些"也一直空着。现在按 12 条一片、**从最新的一片开始**逐片出，
   * 每回来一片就显示一次（`partial` = 还没回来的片数）。
   *
   * ⚠️ **带 `partial` 的结果不许落盘**（浏览器 localStorage / 内存 `results`）：
   * 否则下次打开会把"半份判定"当成最终结论，而界面上看不出它是半份。
   * 落盘只发生在最后一片回来之后（见 `semanticIsComplete`）。
   */
  partial?: number
}

type SemanticState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: SemanticResult }
  | { kind: 'failed'; detail: string }

function readSemantic(sessionId: string | undefined, hash: string): SemanticResult | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(`${SEMANTIC_KEY}${sessionId ?? 'default'}`)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as SemanticResult
    return parsed.hash === hash ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeSemantic(sessionId: string | undefined, result: SemanticResult): void {
  try {
    globalThis.localStorage?.setItem(`${SEMANTIC_KEY}${sessionId ?? 'default'}`, JSON.stringify(result))
  } catch {
    // 存不下就算了：结论还能用，只是下次要重新请求
  }
}

/**
 * 模块级：**按指纹**去重，不按会话。
 *
 * 判定的输入只有内容（组目标 + 若干句理解），**与哪个会话无关**——
 * 所以同一个指纹在两个会话里问两次是白花钱。第一版把会话 id 也编进了键，
 * 于是在"会话先借来、再落到真实会话"的那一帧里发了两遍（实测 2 次请求）。
 *
 * `results` 是内存里的结果缓存：localStorage 是按会话存的，跨会话复用不了。
 */
/**
 * **在飞请求记 promise，不是布尔**（使用者 2026-10-14："正在进行语义核查时切到对话 tab
 * 再回来，就变成尚未判定"）。
 *
 * 原来是个 `Set`：切走时 effect 重跑、cleanup 把 `cancelled` 置真，回来的响应被丢；
 * 而切回来时 `inFlight.has(hash)` 为真 ⇒ **直接 return、不设状态** ⇒ 面板停在
 * "尚未判定"（初始 `idle`）——宿主其实已经算完了，只是没人去拿。
 * 改成存 promise 之后：**后来的挂载会接上同一个 promise**，算完照样落状态与缓存。
 */
const inFlight = new Map<string, Promise<SemanticResult | undefined>>()
const results = new Map<string, SemanticResult>()

/**
 * 判定材料：**按任务节点给**（容器已从话题组换成 DAG 节点）。

/** 会话语义判定的 React 状态机。`hash` 为空（还没有内容）时不请求。 */
function useSemantic(
  sessionId: string | undefined,
  hash: string,
  material: SemanticMaterial,
  enabled: boolean,
): SemanticState {
  const [state, setState] = useState<SemanticState>({ kind: 'idle' })
  // **材料放进 ref，不进依赖数组。**
  //
  // 第一版把 `material` 放进了 deps，而它是每次渲染新建的对象——effect 于是
  // 每渲染一次就重跑、cleanup 把 `cancelled` 置真，**回来的响应被丢弃**。
  // 症状极具迷惑性：宿主日志明明写着 `computed`，界面却永远停在"正在问模型…"。
  // 依赖只留真正决定"要不要请求"的三样：会话、指纹、可见性。
  const materialRef = useRef(material)
  materialRef.current = material
  useEffect(() => {
    // **没有会话 id 就不要发请求。** 第一版漏了这一条：面板首帧 `data` 还是
    // undefined、作用域里也没有会话，于是发出去的是 `{}`，宿主回
    // `{"error":"unknown session"}`（404）。而这个失败看起来像"路由没挂上"，
    // 我照着 404 去查了一遍路由——**查错了方向**。所以：宁可先不发。
    if (!enabled || hash === '' || sessionId === undefined || sessionId === '') return
    const cached = results.get(hash) ?? readSemantic(sessionId, hash)
    if (cached !== undefined) {
      setState({ kind: 'done', result: cached })
      return
    }
    // **已经在飞就接上它**（切 tab 回来属于这种），而不是静默返回
    const running = inFlight.get(hash)
    if (running !== undefined) {
      setState({ kind: 'running' })
      let attached = true
      void running
        .then((result) => {
          if (attached && result !== undefined) setState({ kind: 'done', result })
        })
        .catch(() => {
          /* 失败由发起那一次负责报错 */
        })
      return () => {
        attached = false
      }
    }
    setState({ kind: 'running' })
    let cancelled = false
    const task = (async (): Promise<SemanticResult | undefined> => {
      try {
        /**
         * **分片请求**：宿主一次只收 200 条（`readRequest` 的硬线），而长会话的候选会更多。
         * 以前材料在 200 处截断 ⇒ 后面的回合永不判、界面上只是"那些回合没有标记"。
         * 现在按时间切片逐片问，把结论并起来；逐回合缓存让每片只算新东西。
         */
        const shards = planMaterialRequests(materialRef.current, PROGRESS_SHARD_TURNS)
        const merged: SemanticVerdict[] = []
        let judged = 0
        let reused = 0
        let model = ''
        let votes: number | undefined
        /**
         * **从最新的一片开始**（使用者："最新的回合需要标识…了解目前位置"）：
         * 先判当前所在的这一段，老的回合随后补齐。顺序只影响"先看到谁"，
         * 分片指纹仍按**原始下标**算（`shardHash(hash, index)`），换序不改身份。
         */
        const order = shards.map((shard, index) => ({ shard, index })).reverse()
        /** 每回来一片就显示一次（`pending` = 还没回来的片数）。 */
        const publish = (pending: number): void => {
          if (cancelled) return
          setState({
            kind: 'done',
            result: {
              hash,
              model,
              at: Date.now(),
              verdicts: [...merged].sort((left, right) => left.turn - right.turn),
              ...(typeof votes === 'number' ? { votes } : {}),
              judged,
              reused,
              ...(pending > 0 ? { partial: pending } : {}),
            },
          })
        }
        for (const [done, { shard, index }] of order.entries()) {
          if (cancelled) return
          const response = await fetch(SEMANTIC_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // 分片指纹必须与整份同构（宿主校验形状）——`shardHash` 是唯一实现，断言盯着它
            body: JSON.stringify({ sessionId, hash: shardHash(hash, index), tasks: shard.tasks, turns: shard.turns }),
          })
          const readPart = await readJsonBody<{
            status?: string
            verdicts?: SemanticVerdict[]
            votes?: number
            judged?: number
            reused?: number
            model?: string
            error?: string
          }>(response)
          const part = readPart.data ?? { error: readPart.error ?? '响应读不出来' }
          if (cancelled) return
          if (Array.isArray(part.verdicts)) merged.push(...part.verdicts)
          judged += part.judged ?? 0
          reused += part.reused ?? 0
          model = part.model ?? model
          votes = part.votes ?? votes
          // 某一篇被拒（材料形状/上限）不该让整块消失：报出来，其余照常
          if (part.error !== undefined) {
            setState({ kind: 'failed', detail: `第 ${index + 1}/${shards.length} 片：${String(part.error).slice(0, 60)}` })
            return
          }
          // **逐片出**（半份只进 state，不落盘——见 `semanticIsComplete`）
          publish(order.length - done - 1)
        }
        const payload = {
          status: 'computed',
          verdicts: merged.sort((left, right) => left.turn - right.turn),
          votes,
          judged,
          reused,
          model,
        } as {
          status?: string
          hash?: string
          model?: string
          at?: number
          verdicts?: SemanticVerdict[]
          votes?: number
          judged?: number
          reused?: number
          detail?: string
          error?: string
        }
        if (cancelled) return
        if (payload.status === 'computed' && Array.isArray(payload.verdicts)) {
          const result: SemanticResult = {
            hash: String(payload.hash ?? hash),
            model: String(payload.model ?? ''),
            at: Number(payload.at ?? Date.now()),
            verdicts: payload.verdicts,
            ...(typeof payload.votes === 'number' ? { votes: payload.votes } : {}),
            ...(typeof payload.judged === 'number' ? { judged: payload.judged } : {}),
            ...(typeof payload.reused === 'number' ? { reused: payload.reused } : {}),
          }
          if (semanticIsComplete(result)) {
            writeSemantic(sessionId, result)
            results.set(hash, result)
          }
          setState({ kind: 'done', result })
          return result
        } else if (payload.status === 'nothing-to-judge') {
          setState({ kind: 'idle' })
        } else if (payload.status === 'cold-session') {
          // 会话不在宿主进程里（还没载入）——这一条要说清楚，否则看起来像坏了
          setState({ kind: 'failed', detail: '这个会话还没在宿主里载入，打开它再回来看' })
        } else if (payload.error !== undefined) {
          // **把宿主说的话显示出来。** 第一版把错误也当成 idle 静默掉，
          // 于是"路由 404"这个假象活了很久。错误必须可见。
          setState({ kind: 'failed', detail: String(payload.error).slice(0, 80) })
        } else {
          // `cached`/`in-flight` 都表示宿主那边有结论或正在算——回到 idle，
          // 下一次投影更新会重新走到这里（那时缓存应该就有了）。
          setState({ kind: 'idle' })
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: 'failed', detail: String((error as Error)?.message ?? error).slice(0, 80) })
        }
        throw error
      }
    })()
    // **把 promise 挂上去**：切走再回来时，后来那次挂载会接上同一个 promise
    //（算完照样落 `results` 与状态）——这是使用者报的那个 bug 的根治点。
    inFlight.set(hash, task)
    void task.catch(() => {
      /* 报错由发起那一次负责；这里只是别让未处理的 rejection 冒出去 */
    })
    void task.finally(() => {
      // 完成（无论成败）就摘掉；成功的结果已经在 `results` 里
      if (inFlight.get(hash) === task) inFlight.delete(hash)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, hash, enabled])
  return state
}

/**
 * 判定材料：**组目标 + 各组里那些"agent 理解"**。
 *
 * 判哪三类回合由 `shared/semantic.ts` 的 `semanticMaterial` 决定（一处实现）：
 * **简报回合 / 新增节点的起点回合 / 上下文压缩过的回合**
 * （使用者 2026-10-10 裁定："中间过程是比较难偏移的"）。
 */
/**
 * 任务结构那条路的取数。
 *
 * 与 `useSemantic` 同一套坑与做法：材料（回合原文）走 `ref`、依赖只留
 * 会话 + 指纹 + 可见性；没有会话 id 就不发请求（首帧发 `{}` 会被宿主回
 * "unknown session"，看起来像路由没挂上）。
 *
 * 不同之处只有两点，都是刻意的：
 *
 * - **只问一次**（结构是多轮流水线，不是多票判定）；
 * - **失败不留痕**：宿主回 `ok:false` 时面板只是不显示这一块，不影响其余部分。
 */
interface StructurePayload {
  nodes: Record<string, { parents: string[]; title: string; kind?: string }>
  membership: Record<string, string[]>
}

interface StructureState {
  kind: 'idle' | 'running' | 'done' | 'failed'
  structure?: StructurePayload
  roots?: {
    projects: string[]
    note: string
    forks: { id: string; title: string; at: number }[]
  }
  meta?: {
    calls: number; batches: number; adjudication: string; inherited: number; reasked: number
    /** 这次被跳过的段 + 为什么（判整理/根裁定/补问归属都是可选段，失败不再丢掉整份结构）。 */
    skipped?: string[]
  }
  error?: string
}

function useStructure(
  sessionId: string | undefined,
  hash: string,
  turns: { turn: number; prompt: string }[],
  enabled: boolean,
): StructureState {
  const [state, setState] = useState<StructureState>({ kind: 'idle' })
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  useEffect(() => {
    if (!enabled || hash === '' || sessionId === undefined || sessionId === '') return
    if (turnsRef.current.length === 0) return
    let cancelled = false
    setState({ kind: 'running' })
    void (async () => {
      try {
        const response = await fetch(STRUCTURE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, contentHash: hash, turns: turnsRef.current }),
        })
        const read = await readJsonBody<{
          ok?: boolean
          structure?: StructurePayload
          roots?: StructureState['roots']
          meta?: StructureState['meta']
          error?: string
        }>(response)
        if (read.data === undefined) {
          if (!cancelled) setState({ kind: 'failed', error: read.error ?? '响应读不出来' })
          return
        }
        const payload = read.data
        if (cancelled) return
        if (payload.ok === true && payload.structure !== undefined) {
          setState({ kind: 'done', structure: payload.structure, roots: payload.roots, meta: payload.meta })
        } else {
          setState({ kind: 'failed', error: String(payload.error ?? '未知原因') })
        }
      } catch (error) {
        if (cancelled) return
        setState({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, hash, enabled])
  return state
}

/**
 * 结构请求的材料：宿主投影里逐回合的原文。
 *
 * 回合表已经在 `model.turns` 里对齐好了（宿主那份优先、官方 `turnOutline` 回落），
 * 这里只滤掉没有原文的回合——把"第 N 回合：（空）"喂给批处理是纯噪声，
 * 而批处理的输出要按位置对回回合号，不该有空行占位。
 */
function structureTurns(model: IntentModel | undefined): { turn: number; prompt: string }[] {
  if (model === undefined) return []
  return model.turns
    .filter((turn) => turn.prompt.trim() !== '')
    .map((turn) => ({ turn: turn.turn, prompt: turn.prompt }))
    .sort((a, b) => a.turn - b.turn)
}



/**
 * **徽标文本**：回合区间太长时收起来（使用者 2026-10-13：
 * "同枝下太多回合……还有名称栏那里的横向展示"）。
 *
 * 一个收了三十几个回合、区间又不连续的枝，`compressTurns` 会给出
 * `#1–3、#5、#9、#12–14、#17、#19、#21…` 这么一长串，把节点标题那一行挤爆。
 * 规则：**超过 `BADGE_LIMIT` 个字符就只留前几段 + 「共 N 个回合」**，
 * 完整那串进 `title`（悬停可见）。窄列宽区同一套——它挤的是标题行，与宽度档无关。
 */
export const BADGE_LIMIT = 22

/**
 * **区间行的统计**（B 方案）：`✓×8 · 理解偏×2 · 越界×1 · ↔2`，只写出现过的档；
 * 全是没判过的写 `未判`。
 */
export function rangeStats(
  turns: readonly number[],
  verdicts: ReadonlyMap<number, { match?: boolean; understanding?: boolean; inScope?: boolean; parent?: string }>,
): string {
  let ok = 0; let understanding = 0; let scope = 0; let far = 0; let unknown = 0
  for (const turn of turns) {
    const verdict = verdicts.get(turn)
    if (verdict === undefined) { unknown += 1; continue }
    if (verdict.match === false) {
      if (verdict.understanding === false) understanding += 1
      else scope += 1
    } else ok += 1
    if (verdict.parent === 'far') far += 1
  }
  const parts: string[] = []
  if (ok > 0) parts.push(`✓×${ok}`)
  if (understanding > 0) parts.push(`理解偏×${understanding}`)
  if (scope > 0) parts.push(`越界×${scope}`)
  if (far > 0) parts.push(`↔${far}`)
  if (unknown === turns.length) parts.push('未判')
  return parts.length === 0 ? '未判' : parts.join(' · ')
}

export function badgeText(turns: readonly number[]): string {
  const full = compressTurns([...turns])
  return full.length <= BADGE_LIMIT ? full : `${full.slice(0, BADGE_LIMIT - 1)}…共 ${turns.length} 个`
}

/** 把 `[3,4,5,9]` 压成 `#3–5、#9`（与 shared 那份同规则，纯显示用）。 */
function compressTurns(list: number[]): string {
  if (list.length === 0) return ''
  const out: string[] = []
  let start = list[0]
  let prev = list[0]
  for (const t of list.slice(1)) {
    if (t === prev + 1) {
      prev = t
      continue
    }
    out.push(start === prev ? `#${start}` : `#${start}–${prev}`)
    start = t
    prev = t
  }
  out.push(start === prev ? `#${start}` : `#${start}–${prev}`)
  return out.join('、')
}

/**
 * 结构树：`treeRows`（与研究工具逐字交叉校验过的行）+ `nestRows` 嵌成可折叠的目录树。
 *
 * 为什么用 `<details>/<summary>` 而不是自己管折叠状态：原生元素不需要额外 state、
 * 静态渲染就能折叠，而且**没有 JS 时默认全展开**（不会因为折叠把信息藏没）。
 */
function structureOutline(
  structure: StructurePayload | undefined,
  turns: { turn: number; prompt: string }[],
): { outline: TreeOutline[]; unattached: number[] } {
  if (structure === undefined) return { outline: [], unattached: [] }
  const state = { nodes: structure.nodes, membership: structure.membership }
  const { rows, unattached } = treeRows(state, turns as unknown as TaskTurn[])
  return { outline: nestRows(rows), unattached }
}

/**
 * 一个树节点（递归）。深度 ≤ 1 默认展开，更深的收起——折叠树的常规读法。
 *
 * **节点里直接列出它收的对话**（使用者裁定 2026-10-10：原来那套扁平的话题组列表不要了，
 * 每个对话在节点里面展示更好）。所以这里把回合号 + 原文放进 summary 下面的列表里；
 * 点一条进详情层：那一层是这个节点**收的全部回合**（含它没在树上展开的父子信息），
 * 不是 summary 这一行的重复。
 */
/** 拖拽事件里我们真正用到的那几个成员（不引 DOM 类型，宿主/测试都好替身）。 */
type DragLike = {
  stopPropagation?: () => void
  dataTransfer?: {
    setData?: (kind: string, value: string) => void
    getData?: (kind: string) => string
    effectAllowed?: string
  }
}

/** 「一行回合」需要的上下文（`structureNode` 与未挂载区共用同一份形状）。 */
type TurnRowContext = Parameters<typeof structureNode>[2]

/**
 * **渲染一行回合**（树上节点里、以及"没挂任何节点"那一区共用）。
 *
 * 抽出来的理由不只是复用：未挂载的回合**必须和节点里的回合长得一样、能一样地操作**
 * ——否则"独立回合"就只是一串号码，人看得见却够不着（使用者 2026-10-10：
 * *"独立回合还是没有显示，这让我如何进行挂接已有枝或新枝？"*）。
 *
 * `nodeId` 为空串 = 这一行不属于任何节点：编辑态点它 = 选中；非编辑态不跳详情
 * （没有详情可跳）；拖它 = 从"无"拖向某条枝（落点是加，不是替换）。
 */
function turnRowElement(
  context: TurnRowContext,
  nodeId: string,
  turn: number,
  key: string,
): ReturnType<typeof createElement> {
  const unattached = nodeId === ''
  const text = context.turnText.get(turn)
  const { mark, kind } = verdictMark(context.verdicts.get(turn))
  const markStyle = { color: MARK_COLOR[kind], fontVariantNumeric: 'tabular-nums' as const }
  const line = createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
    createElement(
      'span',
      { style: { color: TURN_NO, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto', fontWeight: 600 } },
      `#${turn}`,
    ),
    createElement('span', { style: { ...markStyle, flex: '0 0 auto' } }, mark),
    // **同一条回合挂在几处**（`~/dag-view` 的启示：图的价值在于"同一节点的多条边一眼看得见"）。
    // 我们的树里一个回合会出现在每个挂它的枝下，但原来**看不出"它还挂在哪儿"**。
    (context.turnPlaces?.get(turn) ?? []).length > 1
      ? createElement(
          'span',
          {
            'data-intent-turn-places': `${turn}:${(context.turnPlaces?.get(turn) ?? []).length}`,
            title: `这一条回合同时挂在 ${(context.turnPlaces?.get(turn) ?? []).length} 条枝下：${(context.turnPlaces?.get(turn) ?? []).join('、')}`,
            style: { fontSize: 9.5, color: MUTED, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' },
          },
          `×${(context.turnPlaces?.get(turn) ?? []).length}`,
        )
      : null,
    context.latestTurn !== undefined && turn === context.latestTurn
      ? createElement(
          'span',
          {
            'data-intent-latest': String(turn),
            title: '这是这个会话里最新的一个回合——你现在的位置',
            style: { fontSize: 9.5, fontWeight: 600, color: ACCENT, flex: '0 0 auto', border: `1px solid ${ACCENT}`, borderRadius: 4, padding: '0 4px', lineHeight: '14px' },
          },
          '现在',
        )
      : null,
    // **第三问单独一档**（使用者裁定"结论分开"）：`↔较远` 与 `✓/理解偏/越界` 不是一回事
    // ——前者说"挂在这儿贴不贴"，后者说"agent 做得对不对"。混在一列会读不出来。
    context.verdicts.get(turn)?.parent === 'far'
      ? createElement(
          'span',
          { 'data-intent-parent': 'far', style: { color: PARENT_FAR, flex: '0 0 auto' }, title: '这一回合与父枝目标较远（顶层枝则是偏出领域）——只是提示，不代表 agent 做错了' },
          '↔较远',
        )
      : null,
    text === undefined
      ? null
      : createElement(
          'span',
          { style: { color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          snippet(text, context.snippetLen ?? 44),
        ),
  )
  const picked = context.selected.has(turn)
  const pickable = context.editing && context.onToggleTurn !== undefined
  const baseStyle = {
    display: 'block', width: '100%', textAlign: 'left' as const, cursor: 'pointer',
    border: 'none', color: 'inherit', font: 'inherit',
    padding: '1px 0 1px 14px', fontSize: 10.5, lineHeight: 1.5,
    background: picked ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
    borderRadius: 3,
  }
  if (text === undefined && !pickable) {
    return createElement(
      'div',
      { key, 'data-intent-verdict': kind, style: { color: FAINT, padding: '1px 0 1px 14px', fontSize: 10.5 } },
      line,
    )
  }
  // 未挂载 + 只读：没有节点可进 ⇒ 不装成按钮（按钮点了没反应比不是按钮更糟）
  if (unattached && !pickable) {
    return createElement(
      'div',
      { key, 'data-intent-verdict': kind, 'data-intent-unattached-row': turn, style: { ...baseStyle, cursor: 'default' } },
      line,
    )
  }
  return createElement(
    'button',
    {
      key,
      type: 'button',
      'data-intent-verdict': kind,
      'data-intent-pick': pickable ? turn : undefined,
      'data-intent-selected': picked ? 'true' : undefined,
      ...(unattached ? { 'data-intent-unattached-row': turn } : {}),
      onClick: () => {
        if (pickable) context.onToggleTurn?.(turn)
        else if (!unattached) context.onOpenNode(nodeId)
      },
      draggable: pickable,
      onDragStart: pickable
        ? (event: DragLike) => {
            // **必须停在这里**：否则会冒泡到节点 `<summary>` 的 dragstart，
            // 把"拖一个回合"变成"拖整条枝"（落在枝上=合并、落在回收站=删枝）。
            event.stopPropagation?.()
            context.onDragStart?.(turn, nodeId, event)
          }
        : undefined,
      onDragEnd: pickable ? () => context.onDragEnd?.() : undefined,
      title: pickable
        ? unattached
          ? '选中这个回合（可多选），或直接把它拖到某条枝上（拖到枝上 = 挂上去）'
          : '选中这个回合（可多选），或直接把它拖到目标节点上'
        : '看这个任务收的回合',
      style: text === undefined ? { ...baseStyle, color: FAINT } : baseStyle,
    },
    line,
  )
}

function structureNode(
  node: TreeOutline,
  key: string,
  context: {
    turnText: Map<number, string>
    verdicts: Map<number, SemanticVerdict>
    /** 宽区的区间大小（0 = 不收区间；窄列走"前 N 条 + 还有 N 个"）。 */
    rangeSize?: number
    /** 被**手动收起**的区间（键 `节点id:起始下标`）；默认展开。 */
    collapsedRanges?: Set<string>
    /** 点区间行：展开/收起。 */
    onToggleRange?: (rangeKey: string) => void
    /** 最新回合的**祖先链**（不含直接挂它的那个节点）——那些枝也标「现在」。 */
    nowPath?: Set<string>
    /** 回合号 → 它挂在哪几条枝（标题）；长度 > 1 时行上标 `×N`。 */
    turnPlaces?: Map<number, string[]>
    /**
     * **只收一个回合的枝**（碎片信号）：枝上标 `·1`，概览层有一行汇总。
     * 自动收拢的两条路实测都不动它（判整理空操作、根裁定只管顶层线），所以只提示。
     */
    singleTurn?: Set<string>
    /** 会话里最新的那个回合号——它的行上标「现在」。 */
    latestTurn?: number
    /** 这一档下回合摘要截多长（宽区更长；缺省 = 窄列）。 */
    snippetLen?: number
    onOpenNode: (nodeId: string) => void
    /** 编辑态：点行 = 选中（而不是进详情）。 */
    editing: boolean
    selected: Set<number>
    onToggleTurn?: (turn: number) => void
    /** 拖拽：正在拖的回合（单选或选中的一批）。 */
    dragging?: number[]
    /** 正在拖的枝条（节点 id）——拖到别的枝条上 = 合并。 */
    draggingNode?: string
    onNodeDragStart?: (nodeId: string) => void
    onDragStart?: (turn: number, fromNode: string, event?: DragLike) => void
    onDragEnd?: () => void
    /** 挂在哪个节点上（高亮用）。 */
    hoverNode?: string
    /** 这一档下一个节点最多列几条回合（宽区更多；缺省 = 窄列）。 */
    turnPreview?: number
    /** 生效结构（判"能不能拆"要用）。 */
    graph?: TaskGraph
    /** 节点级面板：改名 / 拆分（树上入口，编辑态才有）。 */
    nodePanel?: { id: string; kind: 'rename' | 'split' | 'merge' }
    onOpenNodePanel?: (id: string, kind: 'rename' | 'split' | 'merge' | undefined) => void
    /** 「合并到…」的提交。 */
    onCommitMergeInto?: (id: string, into: string) => void
    nodeDraft?: string
    onNodeDraft?: (text: string) => void
    nodePicks?: string[]
    onToggleNodePick?: (id: string) => void
    /** 本节点收的回合（拆分的候选之一："有回合就能拆"）——面板按 row.id 自己过滤。 */
    membership?: Record<string, string[]>
    nodeTurnPicks?: number[]
    onToggleNodeTurnPick?: (turn: number) => void
    onCommitRename?: (id: string, title: string) => void
    /** **删除这一枝**（触屏等价路径：拖进回收站在触屏上做不到）。 */
    onDeleteNode?: (id: string) => void
    onCommitSplit?: (id: string, title: string, picks: { turns: number[]; children: string[] }) => void
    onHoverNode?: (nodeId: string | undefined) => void
    onDropOn?: (nodeId: string, event?: DragLike) => void
  },
): ReturnType<typeof createElement> {
  const { row, children } = node
  /**
   * **节点行与会话行要分得开**（使用者："节点和实际会话要有区分度"）。
   *
   * 之前两者都是同一行文字，`标题 ← #1–3 [备注]` 挤在一起，扫不动。现在：
   * - **节点行**：加粗标题 + 左侧 2px 色条 + 回合区间做成等宽徽标（`#1–3`，淡底）；
   * - **会话行**：再缩进一级、字号更小、编号等宽 + 语义标记单独着色 + 正文淡化，
   *   并且只在悬停时给底色（它是"内容"，不是"结构"）。
   */
  const titleLine = createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'baseline', gap: 6, whiteSpace: 'normal' } },
    createElement('span', { style: { fontWeight: 600 } }, row.title),
    row.kind === 'aside'
      ? createElement(
          'span',
          { style: { fontSize: 10, color: MUTED, border: `1px solid ${MUTED}`, borderRadius: 4, padding: '0 4px' } },
          '插话',
        )
      : null,
    createElement(
      'span',
      {
        // 完整区间放 title：徽标收起时，悬停仍能看到全部
        ...(row.turns.length > 0
          ? {
              title:
                `${compressTurns(row.turns)}（共 ${row.turns.length} 个回合）` +
                // 学 `~/dag-view` 的"每张图一行统计"：口径**不依赖闭包**（收了多少回合、
                // 多少条被标），只放在悬停里——横向已经被徽标挤过了，不再加常显文字
                ` · 被标 ${row.turns.filter((t) => context.verdicts.get(t)?.match === false).length} 条` +
                (row.turns.filter((t) => context.verdicts.get(t)?.parent === 'far').length > 0
                  ? ` · 较远 ${row.turns.filter((t) => context.verdicts.get(t)?.parent === 'far').length} 条`
                  : ''),
            }
          : {}),
        style: {
          fontSize: 10, color: MUTED, fontVariantNumeric: 'tabular-nums',
          background: 'color-mix(in srgb, currentColor 8%, transparent)',
          borderRadius: 4, padding: '0 4px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      },
      row.turns.length > 0 ? badgeText(row.turns) : '没有回合',
    ),
    row.notes.length > 0
      ? createElement('span', { style: { fontSize: 10, color: COMPACT } }, row.notes.join(' · '))
      : null,
    /**
     * **枝条级的第三问汇总**（使用者 2026-10-10："父枝远近在主界面应该也有显示标签"）。
     *
     * 逐回合的 `↔较远` 只在**展开的回合行**上看得到，而节点默认最多列 6 条、
     * 折叠时更是一条都看不到。所以这里在**节点行**上给一个计数徽标：
     * 一眼看出"这一枝里有几个回合离父枝较远"，不用逐条翻。
     * 颜色与逐回合那档同一色系（青灰），并且**不是**错误标记的语气。
     */
    /**
     * **枝上也标「现在」**（使用者 2026-10-14："当前回合的标签也放到枝那里，
     * 因为回合可能处于折叠状态"）。
     *
     * 回合行本身有「现在」，但节点/区间一收起就看不见了 ⇒ 枝这一行也标一个，
     * 目的是任何时候都能一眼找到"我在哪一枝"。
     */
    // **祖先链**：最新回合向上推经过的每一枝都标「现在」（使用者 2026-10-14：
    // "一条完整枝（从回合向上推）都标现在吗"）。与"直接挂着它的那一枝"分两个属性，
    // 便于断言与排查区分；样式同为强调蓝，但祖先那条用虚线边框表示"通向"。
    context.nowPath?.has(row.id) === true
      ? createElement(
          'span',
          {
            'data-intent-node-now-path': row.id,
            title: `这一枝通向当前回合（#${context.latestTurn ?? ''}）——从它挂的节点往上推的路径`,
            style: {
              fontSize: 10, fontWeight: 600, color: ACCENT, marginLeft: 6,
              border: `1px dashed ${ACCENT}`, borderRadius: 4, padding: '0 4px',
            },
          },
          '现在',
        )
      : null,
    context.singleTurn?.has(row.id) === true
      ? createElement(
          'span',
          {
            'data-intent-single-turn': row.id,
            title: '这一枝只收了一个回合（碎片信号）——编辑态可以用「合并到…」把它并进相邻枝',
            style: {
              fontSize: 10, color: FAINT, marginLeft: 6,
              border: `1px dashed ${FAINT}`, borderRadius: 4, padding: '0 3px',
            },
          },
          '·1',
        )
      : null,
    context.latestTurn !== undefined && row.turns.includes(context.latestTurn)
      ? createElement(
          'span',
          {
            'data-intent-node-latest': row.id,
            title: `你现在在这个枝里：最新回合（#${context.latestTurn}）挂在它下面`,
            style: {
              fontSize: 10, fontWeight: 600, color: ACCENT, marginLeft: 6,
              border: `1px solid ${ACCENT}`, borderRadius: 4, padding: '0 4px',
            },
          },
          '现在',
        )
      : null,
    (() => {
      const far = row.turns.filter((turn) => context.verdicts.get(turn)?.parent === 'far').length
      return far === 0
        ? null
        : createElement(
            'span',
            {
              'data-intent-node-parent-far': `${row.id}:${far}`,
              title: `这一枝下有 ${far} 个回合与父枝目标较远（顶层枝则是偏出领域）——逐条看展开的回合行`,
              style: {
                fontSize: 10, color: PARENT_FAR, marginLeft: 6,
                border: `1px solid ${PARENT_FAR}`, borderRadius: 4, padding: '0 4px',
                fontVariantNumeric: 'tabular-nums',
              },
            },
            `↔${far}`,
          )
    })(),
  )
  const label = titleLine
  const turnLines = row.turns.map((turn) => turnRowElement(context, row.id, turn, `${key}-t${turn}`))
  /**
   * **同枝回合太多的展示（B 方案 + 两处改进，使用者 2026-10-13）**
   *
   * 宽区按**区间成行**：每 `RANGE_SIZE` 个回合折成一行
   * `#12–21 ⟨✓×8 · 理解偏×2⟩`，点它就地展开。两处补掉 B 的硬伤：
   * 1. **有标记的回合永远露出**——区间收起时，区间内 `理解偏/越界/较远` 的那几条
   *    仍然直接列在区间行下面（B 最怕的就是"问题被折叠起来看不见"）；
   * 2. **最后一个区间默认展开**——吸收 A 的优点：`现在` 那一条恒在屏上。
   *
   * 其余区间按需展开（状态在 tab 层，`expandedRanges`）。窄列仍是老行为（前 6 条 + "还有 N 个"）。
   */
  const RANGE_SIZE = context.rangeSize ?? 0
  const rangeMode = RANGE_SIZE > 0 && row.turns.length > RANGE_SIZE
  const ranges: { start: number; turns: number[] }[] = []
  if (rangeMode) {
    for (let i = 0; i < row.turns.length; i += RANGE_SIZE) ranges.push({ start: i, turns: row.turns.slice(i, i + RANGE_SIZE) })
  }
  /** 这一回合"有标记"吗（判据说偏、越界、或离父枝较远）——有就必须露出。 */
  const flagged = (turn: number): boolean => {
    const verdict = context.verdicts.get(turn)
    return verdict !== undefined && (verdict.match === false || verdict.parent === 'far')
  }
  const rangeRows = rangeMode
    ? ranges.flatMap((range) => {
        /**
         * **默认展开**（使用者 2026-10-14："我的目的是不进入详情界面也可以看到回合"）。
         * 第一版做成"默认收起、点开才看"，那样反而比"还有 N 个回合"更挡路。
         * 现在区间行只承担**收起**，回合默认全在；收起状态记在 `collapsedRanges`。
         */
        const expandedKey = `${row.id}:${range.start}`
        const expanded = !(context.collapsedRanges?.has(expandedKey) ?? false)
        const flaggedInside = range.turns.filter(flagged)
        const rows: ReturnType<typeof createElement>[] = [
          createElement(
            'button',
            {
              key: `${key}-range-${range.start}`,
              type: 'button',
              'data-intent-range': expandedKey,
              'data-intent-range-expanded': expanded ? 'true' : 'false',
              onClick: (event: { stopPropagation: () => void }) => {
                // **必须 stopPropagation**：回合行都在 `<summary>` 里，冒泡会连带把节点折叠了
                event.stopPropagation()
                context.onToggleRange?.(expandedKey)
              },
              style: {
                display: 'block', width: '100%', textAlign: 'left' as const, cursor: 'pointer',
                border: 'none', background: 'transparent', color: MUTED, font: 'inherit',
                padding: '1px 0 1px 14px', fontSize: 10.5,
              },
            },
            `${expanded ? '▾' : '▸'} #${range.turns[0]}–${range.turns[range.turns.length - 1]}` +
              `　${rangeStats(range.turns, context.verdicts)}` +
              (expanded ? '' : '（已收起）') +
              (context.latestTurn !== undefined && range.turns.includes(context.latestTurn) ? ' · 现在' : ''),
          ),
        ]
        if (expanded) {
          // 默认路径：区间里的回合**全部列出**（不进详情也看得到）
          for (const turn of range.turns) rows.push(turnRowElement(context, row.id, turn, `${key}-t${turn}`))
        } else {
          // 手动收起时，**有标记的**那几条仍然露出（B 的硬伤之一）
          for (const turn of flaggedInside) rows.push(turnRowElement(context, row.id, turn, `${key}-t${turn}`))
        }
        return rows
      })
    : []
  // 两处挂载都走区间 ⇒「还有 N 个回合」这条路已无消费者（使用者 2026-10-14：
  // "全部按方案 B 的设计展示，不再进入详情才能看到全部"）。区间大小为 0 时兜底全列。
  const shown = rangeMode ? rangeRows : turnLines
  return createElement(
    'details',
    {
      key,
      open: row.depth <= 1,
      'data-intent-node': row.id,
      style: { marginLeft: row.depth === 0 ? 0 : 12, marginBottom: 2 },
    },
    createElement(
      'summary',
      {
        style: {
          cursor: 'pointer', whiteSpace: 'pre-wrap',
          // 节点行：左侧 2px 色条 + 稍大字号（结构 vs 内容的第二层区分）
          borderLeft: `2px solid ${row.kind === 'aside' ? MUTED : ACCENT}`,
          paddingLeft: 8, fontSize: 11.5, lineHeight: 1.6,
          // **拖拽落点**：悬停时给出明确的可放置反馈（窄栏里没有反馈很容易拖空）
          ...(context.hoverNode === row.id
            ? { background: 'color-mix(in srgb, #2e6fd9 14%, transparent)', borderRadius: 4, outline: '1px dashed #2e6fd9' }
            : {}),
        },
        // **枝条也能拖**（编辑态）：拖到别的枝条 = 合并，拖到下方投放区 = 删除
        draggable: context.editing && context.onNodeDragStart !== undefined,
        onDragStart: context.editing ? () => context.onNodeDragStart?.(row.id) : undefined,
        // `preventDefault` 是必需的：不阻止默认行为，drop 根本不会触发
        onDragOver: context.editing ? (event: { preventDefault: () => void }) => {
          event.preventDefault()
          context.onHoverNode?.(row.id)
        } : undefined,
        onDragLeave: context.editing ? () => context.onHoverNode?.(undefined) : undefined,
        onDrop: context.editing
          ? (event: { preventDefault: () => void; dataTransfer?: DragLike['dataTransfer'] }) => {
              event.preventDefault()
              // 拖着枝条落在这条枝上 ⇒ 合并；拖的是回合 ⇒ 移动 / 挂接（看载荷里的 from）
              context.onDropOn?.(row.id, event)
              context.onHoverNode?.(undefined)
            }
          : undefined,
      },
      label,
      children.length > 0 ? createElement('span', { style: { color: MUTED } }, `  （${children.length} 个分支）`) : null,
      // **树上的枝条入口**（编辑态）：拆分与改名是**按钮**（按使用者给的流程），
      // 合并/删除是拖拽（拖到别的枝 = 合并，拖进回收站 = 删除）。
      context.editing && context.onOpenNodePanel !== undefined
        ? createElement(
            'span',
            { 'data-intent-node-buttons': row.id, style: { marginLeft: 6, fontSize: 10 } },
            createElement(
              'button',
              {
                type: 'button',
                'data-intent-node-rename': row.id,
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  context.onOpenNodePanel?.(row.id, context.nodePanel?.id === row.id && context.nodePanel.kind === 'rename' ? undefined : 'rename')
                },
                style: { cursor: 'pointer', border: 'none', background: 'transparent', color: MUTED, font: 'inherit', padding: '0 6px 0 0', textDecoration: 'underline' },
              },
              '改名',
            ),
            // **触屏也能合并枝**（A4）：拖枝条到别的枝上在触屏上做不到，这里给按钮路
            createElement(
              'button',
              {
                type: 'button',
                'data-intent-node-merge': row.id,
                title: '把这一枝并进另一条枝（被并的那条会消失，它的回合与子枝改挂到目标枝上；可撤销）',
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  context.onOpenNodePanel?.(row.id, context.nodePanel?.id === row.id && context.nodePanel.kind === 'merge' ? undefined : 'merge')
                },
                style: { cursor: 'pointer', border: 'none', background: 'transparent', color: MUTED, font: 'inherit', padding: '0 6px 0 0', textDecoration: 'underline' },
              },
              '合并到…',
            ),
            // **触屏也能删枝**（A4）：拖进回收站在触屏上做不到，这里给一条按钮路。
            // 后果写在 title 里（几点枝、几个回合变独立），用的就是回收站那份 `deleteImpact`。
            createElement(
              'button',
              {
                type: 'button',
                'data-intent-node-delete': row.id,
                title: (() => {
                  const impact = context.graph === undefined ? undefined : deleteImpact(context.graph, row.id)
                  const below = (impact?.nodes.length ?? 1) - 1
                  return (
                    `删除这一枝` +
                    (below > 0 ? `及下挂 ${below} 个枝` : '') +
                    (impact !== undefined && impact.orphaned.length > 0 ? `——其中 ${impact.orphaned.length} 个回合变成独立回合` : '') +
                    '（可撤销）'
                  )
                })(),
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  context.onDeleteNode?.(row.id)
                },
                style: { cursor: 'pointer', border: 'none', background: 'transparent', color: MUTED, font: 'inherit', padding: '0 6px 0 0', textDecoration: 'underline' },
              },
              '删除',
            ),
            canSplit(context.graph, row.id)
              ? createElement(
              'button',
              {
                type: 'button',
                'data-intent-node-split': row.id,
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  context.onOpenNodePanel?.(row.id, context.nodePanel?.id === row.id && context.nodePanel.kind === 'split' ? undefined : 'split')
                },
                style: { cursor: 'pointer', border: 'none', background: 'transparent', color: MUTED, font: 'inherit', padding: 0, textDecoration: 'underline' },
              },
              '拆分',
            )
              : null,
          )
        : null,
    ),
    // ── 树上的节点面板（改名 / 拆分）──────────────────────────────────────
    // 编辑态才出现；点摘要里的「改名」「拆分」切换。
    context.editing &&
    context.nodePanel?.id === row.id &&
    context.onCommitRename !== undefined &&
    context.onCommitSplit !== undefined
      ? createElement(
          'div',
          {
            'data-intent-node-panel-tree': `${row.id}:${context.nodePanel.kind}`,
            style: {
              marginLeft: 10, marginTop: 4, marginBottom: 4, padding: '6px 8px', borderRadius: 6,
              border: `1px solid color-mix(in srgb, currentColor 18%, transparent)`,
              background: 'color-mix(in srgb, currentColor 4%, transparent)', fontSize: 10.5,
            },
          },
          context.nodePanel.kind === 'merge'
            ? createElement(
                'div',
                null,
                createElement('div', { style: { marginBottom: 3, color: MUTED } },
                  '并进哪一条枝？（**这一枝会消失**，它的回合与子枝改挂到目标枝上）'),
                ...(() => {
                  // 候选 = 除自己与**自己的后代**之外的所有节点。
                  // 并进后代等于成环（校验层也会拒），先排掉——不给人一个按了必失败的按钮。
                  const banned = new Set<string>([row.id])
                  let grew = true
                  while (grew) {
                    grew = false
                    for (const [id, node] of Object.entries(context.graph?.nodes ?? {})) {
                      if (banned.has(id)) continue
                      if (!(node.parents ?? []).some((parent) => banned.has(parent))) continue
                      banned.add(id)
                      grew = true
                    }
                  }
                  return Object.keys(context.graph?.nodes ?? {}).filter((id) => !banned.has(id))
                })().map((target) =>
                  createElement(
                    'button',
                    {
                      key: `merge-${target}`,
                      type: 'button',
                      'data-intent-merge-into': `${row.id}:${target}`,
                      onClick: (event: { stopPropagation: () => void }) => {
                        event.stopPropagation()
                        context.onCommitMergeInto?.(row.id, target)
                      },
                      style: { cursor: 'pointer', font: 'inherit', marginRight: 6, textDecoration: 'underline', border: 'none', background: 'transparent', color: 'inherit' },
                    },
                    context.graph?.nodes[target]?.title ?? target,
                  ),
                ),
              )
            : context.nodePanel.kind === 'rename'
            ? createElement(
                'span',
                null,
                createElement('input', {
                  type: 'text',
                  value: context.nodeDraft ?? '',
                  placeholder: row.title,
                  'data-intent-tree-input': 'rename',
                  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                  onChange: (event: { target: { value: string } }) => context.onNodeDraft?.(event.target.value),
                  style: { font: 'inherit', width: '55%' },
                }),
                // **就地校验**：撞名当场说，别等提交后被拒、再去结构块找那句"没生效"
                (() => {
                  const draft = (context.nodeDraft ?? '').trim()
                  const clash =
                    draft === '' || context.graph === undefined
                      ? undefined
                      : siblingTitleConflict(context.graph.nodes, row.id, draft)
                  return clash === undefined
                    ? null
                    : createElement(
                        'span',
                        { 'data-intent-rename-clash': row.id, style: { color: LOW, marginLeft: 6 } },
                        `同级已有「${draft}」`,
                      )
                })(),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-tree-save': 'rename',
                    disabled: (() => {
                      const draft = (context.nodeDraft ?? '').trim()
                      return draft === '' || (context.graph !== undefined && siblingTitleConflict(context.graph.nodes, row.id, draft) !== undefined)
                    })(),
                    onClick: (event: { stopPropagation: () => void }) => {
                      event.stopPropagation()
                      context.onCommitRename?.(row.id, (context.nodeDraft ?? '').trim())
                    },
                  },
                  ' 保存',
                ),
              )
            : createElement(
                'div',
                null,
                createElement('div', { style: { marginBottom: 3, color: MUTED } },
                  '拆出新枝，把哪些**回合**或**子枝**分过去？（它们会从这条枝移走，不是多挂）'),
                createElement('input', {
                  type: 'text',
                  value: context.nodeDraft ?? '',
                  placeholder: '新枝的名字',
                  'data-intent-tree-input': 'split',
                  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                  onChange: (event: { target: { value: string } }) => context.onNodeDraft?.(event.target.value),
                  style: { font: 'inherit', width: '55%' },
                }),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-tree-save': 'split',
                    disabled: (context.nodePicks ?? []).length === 0 && (context.nodeTurnPicks ?? []).length === 0,
                    title:
                      (context.nodePicks ?? []).length === 0 && (context.nodeTurnPicks ?? []).length === 0
                        ? '至少勾一个回合或一条子枝：空的枝会被剪掉'
                        : '拆',
                    onClick: (event: { stopPropagation: () => void }) => {
                      event.stopPropagation()
                      context.onCommitSplit?.(row.id, (context.nodeDraft ?? '').trim(), {
                        turns: context.nodeTurnPicks ?? [],
                        children: context.nodePicks ?? [],
                      })
                    },
                  },
                  ' 拆分',
                ),
                // **有回合就能拆**：把要分出去的回合勾上（使用者纠正过这条）
                ...(Object.entries(context.membership ?? {})
                  .filter(([, list]) => list.includes(row.id))
                  .map(([turn]) => Number(turn))
                  .sort((a, b) => a - b)).map((turn: number) =>
                  createElement(
                    'label',
                    { key: `split-t${turn}`, style: { display: 'block', cursor: 'pointer' } },
                    createElement('input', {
                      type: 'checkbox',
                      'data-intent-tree-turn-pick': turn,
                      checked: (context.nodeTurnPicks ?? []).includes(turn),
                      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                      onChange: () => context.onToggleNodeTurnPick?.(turn),
                    }),
                    ` #${turn} ${(context.turnText.get(turn) ?? '').slice(0, 18)}`,
                  ),
                ),
                ...children.map((child) =>
                  createElement(
                    'label',
                    { key: `split-${child.row.id}`, style: { display: 'block', cursor: 'pointer' } },
                    createElement('input', {
                      type: 'checkbox',
                      'data-intent-tree-pick': child.row.id,
                      checked: (context.nodePicks ?? []).includes(child.row.id),
                      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                      onChange: () => context.onToggleNodePick?.(child.row.id),
                    }),
                    ` 枝：${child.row.title}`,
                  ),
                ),
              ),
        )
      : null,

    // 会话行整体**再缩进一级并带引导线**：一眼看出"这些属于上面那个节点"
    createElement(
      'div',
      {
        style: {
          marginLeft: 8, paddingLeft: 8,
          borderLeft: `1px dashed color-mix(in srgb, currentColor 22%, transparent)`,
        },
      },
      ...shown,
    ),
    ...children.map((child, index) => structureNode(child, `${key}.${index}`, context)),
  )
}

/**
 * **撤销栈**（A4：多步撤销）。
 *
 * 现在只有"回收站单次撤销"与"逐条还原"，误操作一步就没法退回。
 * 这一对是纯函数（可断言），面板只负责在 `applyOverrideList` 里压栈、
 * 在 `Ctrl+Z` 里出栈。
 *
 * 三条契约：
 * - **后进先出**：撤销回到上一个状态，而不是最初状态；
 * - **上限**：只留最近 `HISTORY_MAX` 版（内存里，不落盘——它是一次编辑会话内的事，
 *   刷新后重来是对的：刷新后你的"上一步"已经不是同一个上下文了）；
 * - **空栈出栈 = 不动**（返回 `undefined`，调用方据此不写回）。
 */
export const HISTORY_MAX = 20

export function pushHistory(stack: readonly TaskOverride[][], list: readonly TaskOverride[]): TaskOverride[][] {
  return [...stack, [...list]].slice(-HISTORY_MAX)
}

export function popHistory(stack: readonly TaskOverride[][]): { stack: TaskOverride[][]; list?: TaskOverride[] } {
  if (stack.length === 0) return { stack: [] }
  const list = stack[stack.length - 1]
  return { stack: stack.slice(0, -1), list: [...list] }
}

/**
 * **一条覆盖说成人话**（面板上要把"我到底改过什么"写出来）。
 *
 * 为什么必须有：使用者连着两轮报"改了但面板没反应"，而面板**此前从不显示
 * 自己收到了什么**——`overrideCount` 只写在一个不显示的 `data-` 属性上。
 * 于是"操作没落地"和"落地了但渲染不对"这两种完全不同的故障，从界面上看一模一样。
 * 判据要可观测：先让改动自己说话。
 */
export function describeOverride(override: TaskOverride, graph?: TaskGraph): string {
  const title = (id: string): string => `「${String(graph?.nodes[id]?.title ?? id)}」`
  switch (override.op) {
    case 'setPlacement':
      return override.nodes.length === 0
        ? `摘除 #${override.turn} 的落点`
        : `挪 #${override.turn} → ${override.nodes.map(title).join('、')}`
    case 'rename':
      return `改名 ${title(override.id)}`
    case 'delete':
      return `删枝条 ${title(override.id)}`
    case 'merge':
      return `合并 ${override.from.map(title).join('、')} → ${title(override.into)}`
    case 'create':
      return `新增枝 ${title(override.id)}`
    case 'reparent':
      return `改挂 ${title(override.id)}`
    default:
      return String((override as { op?: unknown }).op ?? '?')
  }
}

/** 覆盖列表的一行摘要（最多列 3 条，其余折成"等 N 条"）。 */
export function describeOverrides(overrides: readonly TaskOverride[], graph?: TaskGraph): string {
  const shown = overrides.slice(0, 3).map((item) => describeOverride(item, graph))
  const rest = overrides.length - shown.length
  return shown.join(' · ') + (rest > 0 ? ` · 等 ${rest} 条` : '')
}

/**
 * 人工覆盖的三个小工具（纯函数，便于断言）。
 *
 * 一条 `setPlacement` 就是"这个回合挂到这些节点上"；同回合**只留最后一条**
 * （改两次不该在列表里堆两条——回放顺序会决定结果，那是隐患）。
 */
function placementOf(overrides: readonly TaskOverride[], turn: number): string[] | undefined {
  let found: string[] | undefined
  for (const item of overrides) if (item.op === 'setPlacement' && item.turn === turn) found = item.nodes
  return found
}


function withPlacement(overrides: readonly TaskOverride[], turn: number, nodes: string[]): TaskOverride[] {
  const kept = overrides.filter((item) => !(item.op === 'setPlacement' && item.turn === turn))
  // 空数组 = 明确"这个回合不挂任何节点"（也是有效的人工决定，保留下来）
  return [...kept, { op: 'setPlacement', turn, nodes: [...nodes] }]
}

/**
 * **拖拽落点**：把若干回合**从源节点挪到目标节点**。
 *
 * ⚠️ 这里踩过一次语义错误（使用者当场指出）：第一版做成了**附加**（多挂一个），
 * 而那违背手势直觉——树上一个回合会出现在**每个**挂它的节点下面，
 * 所以"拖某一行"天然意味着**把它这一份从所在节点挪走**，而不是又挂一个。
 * 想"多挂"是另一件事，用「挂到…」按钮（那里的语义明确写着"附加"）。
 *
 * 规则（纯函数，便于断言——拖拽本身没法离线测，但这一步可以）：
 * - 去掉 `fromNode`（若本来没有它，就只做加法：那条大概是从别处选来的）；
 * - 加上 `toNode`；
 * - **其他落点一个都不动**（别的枝上那一份仍然在，这才是"多挂"的正确用法）；
 * - `fromNode === toNode` ⇒ 原样返回（拖回原处不该产生一条无意义的覆盖）。
 */
function moveTurns(
  overrides: readonly TaskOverride[],
  graph: TaskGraph | undefined,
  turns: readonly number[],
  fromNode: string,
  toNode: string,
): TaskOverride[] {
  if (fromNode === toNode) return [...overrides]
  let next = [...overrides]
  for (const turn of turns) {
    const current = placementOf(next, turn) ?? (graph?.membership[String(turn)] ?? [])
    const kept = current.filter((id) => id !== fromNode)
    next = withPlacement(next, turn, [...new Set([...kept, toNode])])
  }
  return next
}

/**
 * **落在一条枝上该做什么**（纯函数，便于断言）。
 *
 * 三种来源：拖枝条（合并）／拖回合（移动）／**从"没挂任何节点"拖回合（挂上去）**。
 * 最后这种曾经整个不工作——处理器没接上（见 `nodeRowContext` 的注释），
 * 界面看起来完全一样（行能拖起来），落点却什么也读不到。
 */
export function dropOnNode(
  overrides: readonly TaskOverride[],
  graph: TaskGraph | undefined,
  payload: { turns: number[]; from: string },
  nodeId: string,
): TaskOverride[] {
  // `from === ''` = 从"没挂任何节点"那一区拖来的：没有源节点可去掉 ⇒ 追加（挂上去）
  return payload.from === ''
    ? attachTurns(overrides, graph, payload.turns, nodeId)
    : moveTurns(overrides, graph, payload.turns, payload.from, nodeId)
}

/** 拖拽载荷的 MIME。**用它而不是只靠 React 状态**：见 `encodeDrag` 的说明。 */
export const DRAG_MIME = 'application/x-intent-view-drag'

/**
 * **拖着什么，直接写进 `dataTransfer`**。
 *
 * ## 为什么不能只靠 React 状态（使用者 2026-10-10："直接拖动挂不了"）
 *
 * 树上一条枝条的 `dragstart` 挂在 `<summary>` 上，而**回合行是 summary 的子元素**
 * ——HTML5 的 drag 事件会冒泡。于是拖一个回合时，两个处理器都会跑：
 * 先回合行（`setDragging([turn])`、`setDraggingFrom(nodeId)`），紧接着
 * summary（`onNodeDragStart` ⇒ `setDraggingNode(nodeId)` **并且 `setDragging([])`**）
 * ——后面的把前面的**清空**了。结果"拖一个回合"变成了"拖整条枝"：
 * 落在别的枝上会**合并两条枝**，落在回收站会**删掉整条枝**（破坏性，且没有任何提示）。
 *
 * 载荷放进 `dataTransfer` 之后，落点读到的是**按下鼠标那一刻**的事实，
 * 不再经过"状态有没有被同一次事件链覆盖"这一层；回合行的 `dragstart` 同时
 * `stopPropagation()`，双保险。
 */
export function encodeDrag(turns: readonly number[], from: string): string {
  return JSON.stringify({ turns: [...turns], from })
}

/** 读回拖拽载荷；形状不对就当没有（**不抛**——坏载荷不该让落点崩）。 */
export function decodeDrag(raw: string | undefined | null): { turns: number[]; from: string } | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { turns?: unknown; from?: unknown }
    if (!Array.isArray(parsed.turns)) return undefined
    const turns = parsed.turns.filter((t): t is number => Number.isInteger(t))
    if (turns.length === 0) return undefined
    return { turns, from: typeof parsed.from === 'string' ? parsed.from : '' }
  } catch {
    return undefined
  }
}

/**
 * **新建一条枝，并把选中的回合挂上去**（纯函数，便于断言）。
 *
 * 使用者 2026-10-10：*"独立回合还是没有显示，这让我如何进行挂接已有枝或新枝？"*
 * ——挂已有枝是 `attachTurns`（「复制到…」/ 拖到枝上），**新枝**原本没有入口：
 * 树上的「拆分」是从一条已有枝里分出来，独立回合没有枝可分。
 *
 * 两条 op：先 `create` 建容器（**只建枝，不凭空建任务节点**——使用者裁定的边界），
 * 再对每个选中的回合追加这个新枝（是**追加**，原来的落点一个不动）。
 * 顺序不能反：剪枝会把"没有回合的空叶枝"删掉，而这里建完立刻就挂上回合。
 */
export function newBranchOverrides(
  overrides: readonly TaskOverride[],
  graph: TaskGraph | undefined,
  turns: readonly number[],
  id: string,
  title: string,
): TaskOverride[] {
  return [
    ...overrides,
    { op: 'create', id, title, parents: ['root'] },
    ...turns.map((turn) => {
      const current = placementOf(overrides, turn) ?? (graph?.membership[String(turn)] ?? [])
      return { op: 'setPlacement' as const, turn, nodes: [...new Set([...current, id])] }
    }),
  ]
}

/**
 * **这条枝能不能拆**：**有回合就能拆，有子枝也能拆**。
 *
 * 我第一版写成"只有有子枝才能拆"——被使用者纠正：*"应该有回合就可以拆，有子枝也可以拆"*。
 * 理由站得住：**回合是真实发生过的**，把其中几条分到一条新枝下，是**重新分组**，
 * 不是"凭空建一个任务节点"（那条禁令针对的是"没有内容却宣布有这件事"）。
 */
export function canSplit(graph: TaskGraph | undefined, id: string): boolean {
  if (graph === undefined || id === 'root') return false
  const hasTurns = Object.values(graph.membership).some((list) => list.includes(id))
  const hasChildren = Object.values(graph.nodes).some((node) => node.parents.includes(id))
  return hasTurns || hasChildren
}

/**
 * **拆分枝**：新建一条枝，把选中的**子节点**从旧枝改挂到新枝下。
 *
 * 语义是**替换**（孩子的父集合里去掉旧枝、加上新枝），不是"附加"——这才是"拆"：
 * 拆完旧枝少这几个孩子、新枝多这几个，别的枝不受影响。
 *
 * 注意：拆的是**子枝**，不是回合。回合要换地方用拖拽/复制（"只能新增枝、不能凭空建任务节点"
 * 是使用者的裁定——一个能装回合的新节点等于宣称发生了没发生的工作）。
 */
function splitBranch(
  overrides: readonly TaskOverride[],
  graph: TaskGraph | undefined,
  fromNode: string,
  newId: string,
  title: string,
  picks: { turns: readonly number[]; children: readonly string[] },
): TaskOverride[] {
  /**
   * **新枝与原枝同级**（使用者："拆分时新枝和原来的枝应该是同级的"）——
   * 所以新枝继承**原枝的父**，而不是挂在原枝下面。拆一条枝 = 把它一分为二，
   * 两个半截在同一层；挂在下面会变成"原枝下面套一个新枝"，那读起来是嵌套不是拆分。
   */
  const parentsOfFrom = graph?.nodes[fromNode]?.parents ?? ['root']
  const next: TaskOverride[] = [
    ...overrides,
    { op: 'create', id: newId, title, parents: [...parentsOfFrom] },
  ]
  // **回合**：从旧枝移走、加到新枝（其余落点保留——多挂的那几份不动）
  for (const turn of picks.turns) {
    const current = placementOf(next, turn) ?? (graph?.membership[String(turn)] ?? [])
    next.push({ op: 'setPlacement', turn, nodes: [...new Set([...current.filter((id) => id !== fromNode), newId])] })
  }
  // **子枝**：同样是"从旧枝移走、加到新枝"
  for (const child of picks.children) {
    const current = graph?.nodes[child]?.parents ?? []
    next.push({
      op: 'reparent',
      id: child,
      parents: [...new Set([...current.filter((id) => id !== fromNode), newId])],
    })
  }
  return next
}

/** 「挂到…」按钮用的那一步：**附加**一个落点（多父），与拖拽的"挪"区分开。 */
function attachTurns(
  overrides: readonly TaskOverride[],
  graph: TaskGraph | undefined,
  turns: readonly number[],
  nodeId: string,
): TaskOverride[] {
  let next = [...overrides]
  for (const turn of turns) {
    const current = placementOf(next, turn) ?? (graph?.membership[String(turn)] ?? [])
    next = withPlacement(next, turn, [...new Set([...current, nodeId])])
  }
  return next
}

function withoutPlacement(overrides: readonly TaskOverride[], turn: number): TaskOverride[] {
  return overrides.filter((item) => !(item.op === 'setPlacement' && item.turn === turn))
}

/**
 * **一个回合的简单标记**（使用者："语义核查不是应该每个回合都简单标记吗？"）。
 *
 * 判据给四样东西，界面只该给一眼能看懂的标记：
 * - 没判过（这一回合没有可判文本，或还没算完）⇒ `未判`；
 * - 判过且没问题 ⇒ `✓`；
 * - 理解偏了 ⇒ `理解偏`；越界了 ⇒ `越界`；两样都占 ⇒ `理解偏+越界`。
 *
 * 标记只是**提示**：越界尤其如此（要不要挪、挪到哪由人定，系统不自行改动）。
 */
function verdictMark(verdict: (SemanticVerdict & { human?: boolean }) | undefined): { mark: string; kind: string } {
  if (verdict === undefined) return { mark: '未判', kind: 'none' }
  // 人工判定过的：后缀一个 `·人`，一眼能看出这条结论不是模型给的
  const human = verdict.human === true ? '·人' : ''
  const understanding = verdict.understanding === false
  const scope = verdict.inScope === false
  if (!understanding && !scope) return { mark: `✓${human}`, kind: 'ok' }
  if (understanding && scope) return { mark: `理解偏+越界${human}`, kind: 'both' }
  return understanding
    ? { mark: `理解偏${human}`, kind: 'understanding' }
    : { mark: `越界${human}`, kind: 'scope' }
}

/** 会话 id 的来源：**作用域里有就用它**；只有在应用层（没有会话）时才借一个。 */
function sessionCache(
  list: SessionsListLike | undefined,
  preferred: string | undefined,
): {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => PickedSession
} {
  const none: PickedSession = { id: undefined, borrowed: false }
  let cached: PickedSession = none
  let primed = false
  return {
    subscribe: (listener) => {
      const invalidate = (): void => {
        primed = false
        listener()
      }
      return list?.subscribe?.(invalidate) ?? (() => {})
    },
    getSnapshot: () => {
      if (!primed) {
        cached = pickSession(list?.getSnapshot?.(), preferred) ?? none
        primed = true
      }
      return cached
    },
  }
}

/** 渲染期可读的会话数据。`active` 为假时不订阅——面板收起时无需跟随。 */
function useIntentData(
  ctx: ContextLike | undefined,
  preferred: string | undefined,
  active: boolean,
):
  | { projection: unknown; title: string; sessionId: string | undefined; borrowed: boolean }
  | undefined {
  const list = active
    ? ((ctx?.get('sessions') as SessionsLike | undefined)?.list ?? undefined)
    : undefined
  const sessions = useMemo(() => sessionCache(list, preferred), [list, preferred])
  const picked = useSyncExternalStore(
    sessions.subscribe,
    sessions.getSnapshot,
    sessions.getSnapshot,
  )
  const sessionId = picked.id
  const entries = useMemo(() => entryCache(list, sessionId), [list, sessionId])
  const entry = useSyncExternalStore(
    entries.subscribe,
    entries.getSnapshot,
    entries.getSnapshot,
  )
  if (entry === undefined) return undefined
  // **选中的会话 id 一并返回**：压缩与基线都按会话查，需要它。
  //
  // 它不一定等于作用域里的那个——**只可能在"作用域里压根没有会话"时不同**
  // （那时是借来的，`borrowed` 为真，界面会显式标注）。
  // 上一版这里会在"当前会话没有投影值"时也跳到别的会话，于是**基线写错键**。
  return { ...entry, sessionId, borrowed: picked.borrowed }
}

// `readBaseline` / `writeBaseline` 与 `graph-view:intent-baseline:*` 的迁移**已删除**
// （B4-4）：基线曾经是贴合度的比较基准，而贴合度随组口径下线，它只剩"改头部一个字符串"
// 的效果。改名需求由**覆盖系统**接管——在详情层对根节点用「改名」（`rename` op），
// 而且是逐会话持久化的，比原来那个只影响显示字符串的机制名副其实。


/**
 * 基线编辑区。
 *
 * 打开时是折叠的——它是**偶尔用一次**的东西，不该占据这个 tab 的主要面积。
 * 展开后显示当前基线的来源，因为你必须能分清
 * "我正在跟会话声明的目标比" 还是 "跟我在这个框里写的比"。
 */

/**
 * `goal/change` 操作的记号与中文名。
 *
 * 记号与颜色只区分**一件事**：这条是不是"目标被建立"。
 * 其余操作（pause / resume / edit / clear / complete）都只是状态变化，
 * 用同一个中性记号——它们的区别在 tooltip 里。
 */
function operationMark(operation: string): string {
  switch (operation) {
    case 'create':
      return ' 建立'
    case 'edit':
      return ' 改'
    case 'pause':
      return ' 停'
    case 'resume':
      return ' 续'
    case 'complete':
      return ' 完成'
    case 'clear':
      return ' 清除'
    default:
      return ` ${operation}`
  }
}

function operationLabel(operation: string): string {
  switch (operation) {
    case 'create':
      return '建立目标'
    case 'edit':
      return '修改目标'
    case 'pause':
      return '暂停'
    case 'resume':
      return '恢复'
    case 'complete':
      return '标记完成'
    case 'clear':
      return '清除目标'
    default:
      return operation
  }
}

/** 一个回合：脊柱上的一个点。 */
function TurnRow({
  turn,
  compressed,
  verdict,
  latest,
}: {
  turn: IntentTurn
  /** 这一回合是不是压缩点。 */
  compressed: boolean
  /** 这一回合的语义标记（没判过就是 `未判`）。 */
  verdict?: SemanticVerdict
  /** 这一回合是不是会话里最新的那个（标「现在」）。 */
  latest?: boolean
}) {
  const { mark, kind } = verdictMark(verdict)
  return createElement(
    'div',
    { style: { display: 'flex', gap: 8, position: 'relative' } },
    // 脊柱：竖线 + 圆点。竖线用一个绝对定位的窄条，圆点压在它上面。
    createElement(
      'div',
      {
        style: {
          flex: '0 0 auto',
          width: 14,
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
        },
      },
      // 脊柱的**上半段**（本行圆点之上）。
      //
      // `compaction/start` 的 `turn` 语义是"压缩发生在该回合开始前"，
      // 所以这一段正是"此处历史被截断"的位置——把它画成琥珀虚线。
      createElement('div', {
        style: {
          position: 'absolute',
          top: 0,
          height: 12,
          width: compressed ? 0 : 1,
          borderLeft: compressed ? `1px dashed ${COMPACT}` : undefined,
          background: compressed
            ? undefined
            : 'color-mix(in srgb, currentColor 22%, transparent)',
        },
      }),
      // 下半段（圆点之下）一贯通到下一行。
      createElement('div', {
          style: {
            position: 'absolute',
            top: 12,
            bottom: -10,
            width: 1,
            background: 'color-mix(in srgb, currentColor 22%, transparent)',
          },
        }),
      createElement('div', {
        style: {
          position: 'relative',
          marginTop: 5,
          width: 7,
          height: 7,
          borderRadius: '50%',
          // 压缩点同时还是个普通回合，所以不覆盖它的填充色——
          // 用一圈琥珀外环表示"这里另有一件事"。
          //
          // 圆点**不再分大小与灰亮**：那两档是按 `brief`（承接/指令型回合）分的，
          // 而 `brief` 是组口径的伴生信号，已随 ③ 离开 wire。
          // **不在浏览器里按字数重算它**——阈值在 `shared/intent.ts`，
          // 在这里再定一个就是"同一语义两处实现"。
          background: ACCENT,
          boxShadow: compressed ? `0 0 0 2px ${COMPACT}` : undefined,
          flex: '0 0 auto',
        },
      }),
    ),
    createElement(
      'div',
      { style: { flex: 1, minWidth: 0, paddingBottom: 10 } },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
        // 回合号用红色（与树上的行同一档），标记按状态着色——两处渲染保持一致
        createElement(
          'span',
          { style: { fontSize: 11, color: TURN_NO, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto', fontWeight: 600 } },
          `#${turn.turn}`,
        ),
        createElement('span', { style: { color: MARK_COLOR[kind], flex: '0 0 auto', fontSize: 10.5 } }, mark),
    latest === true
      ? createElement(
          'span',
          {
            'data-intent-latest': String(turn.turn),
            title: '这是这个会话里最新的一个回合——你现在的位置',
            style: { fontSize: 9.5, fontWeight: 600, color: ACCENT, flex: '0 0 auto', border: `1px solid ${ACCENT}`, borderRadius: 4, padding: '0 4px' },
          },
          '现在',
        )
      : null,

        // 第三问（归属贴近度）：详情层同样单独一档
        verdict?.parent === 'far'
          ? createElement(
              'span',
              {
                'data-intent-parent': 'far',
                style: { color: PARENT_FAR, flex: '0 0 auto', fontSize: 10.5 },
                title: verdict.parentWhy ?? '与父枝目标较远（顶层枝则是偏出领域）——只是提示',
              },
              '↔较远',
            )
          : null,
        // 标记同时作为 DOM 属性暴露：断言与排查都要能一眼看到（值为 ok/understanding/scope/both/none）
        createElement('span', { 'data-intent-verdict': kind, style: { display: 'none' } }, mark),
        compressed
          ? createElement(
              'span',
              {
                title:
                  '这一回合**开始前**发生过上下文压缩：此前累积的历史被摘要替换。' +
                  '判据是 `compaction/start` 事件自带的 turn（真实事件，非启发式）。' +
                  '所以从这一回合起，它与更早历史的字面重合会自然偏低——' +
                  '**那不等于跑题**。',
                style: {
                  fontSize: 9.5,
                  fontWeight: 600,
                  color: COMPACT,
                  border: `1px solid ${COMPACT}`,
                  borderRadius: 4,
                  padding: '0 4px',
                  flex: '0 0 auto',
                  lineHeight: '15px',
                },
              },
              '压缩',
            )
          : null,
        createElement(
          'span',
          {
            style: {
              fontSize: 12,
              lineHeight: 1.4,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: turn.prompt,
          },
          // 有些回合的 prompt 是空的——实测看到 `#36 (空)`、`#37 (空)`，而它们的
          // 回复是有内容的。退回一个笼统的"（空）"会把图上唯一可读的信息丢掉。
          // 没有提问的回合通常正是"继续"这类回合，所以用回复当标签。
          snippet(turn.prompt, 64) || snippet(turn.response, 64) || '（无内容）',
        ),
      ),
      // **agent 当时把任务理解成了什么。**
      //
      // 任何回合都可能有（宿主对每回合都抽；简报回合里用户只说「同意」/「继续吧」，
      // **没有任何具体指称**：短于 12 个二元组、产物记号（路径 / `#N` /
      // 反引号标识符）**一个都没有**（实测 n=211 里 0 个），而 agent 的复述
      // 至少是完整的一句话。所以这里显示的**不是**用户的话，必须标出来。
      //
      // ⚠️ 原先这里引的是"prompt 0.0016 对复述 0.0186（11 倍）"——**那个比较
      // 已撤回**：prompt 是中文、组内文本是中文，而复述多半是英文，两边不在
      // 同一个语言里比（93% 的对是跨语言的），字符二元组跨语言结构性地对不上。
      // 见 `tools/test-language-mixing.mjs`。
      //
      // 缩进 + 左侧竖线，读起来像"引文"；前缀直接写明来源。
      // 思考多为英文，这一句常常是英文原文——**不翻译**（翻译是额外一层失真）。
      // **逐条"可能偏离"标记已撤掉。**
      //
      // 它暗示"问题在这一回合"，而实测**真配对里 57% 的条目都会被标**——
      // 全部条目都亮等于没指位置（`research/semantic-space.md` 第六段）。
      // 区分力是有的（真配对 57% vs 随机配对 93%，差 36 个百分点），
      // 所以这条判定没被丢掉，只是**降级成一句整会话的话**（见概况层状态行）。
      //
      // 撤掉标准是预先定的：**基线过半就不再逐条标**。这与本项目早先废掉
      // "逐回合偏离"（78.5% 标记率）是同一条尺子。
      turn.statement
        ? createElement(
            'div',
            {
              'data-intent-statement': 'true',
              title:
                '**不是用户说的话**：这是 agent 在靠前的思考里对任务的复述（原文，未翻译）。' +
                '这一回合用户只说了一句承接词（如「同意」）——短于 12 个二元组、' +
                '不含任何路径或标识符。它只用于显示，**不参与任何判定**。',
              style: {
                fontSize: 11,
                color: MUTED,
                marginTop: 3,
                paddingLeft: 6,
                borderLeft: `2px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            `agent 理解为：${snippet(turn.statement, 80)}`,
          )
        : null,
      turn.response && turn.prompt
        ? createElement(
            'div',
            {
              style: {
                fontSize: 11,
                color: MUTED,
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: turn.response,
            },
            snippet(turn.response, 84),
          )
        : null,
    ),
  )
}

/**
 * **逐个回合的人工判定**（只出现在详情层）。
 *
 * ## 为什么它留在详情层（使用者 2026-10-10："人工判定可以留在回合详情"）
 *
 * 上一轮把详情层清成纯展示时，连它一起删了。但"这一层的标记对不对"这件事，
 * **只有在这一层读得到原文的地方才判得准**——要改一条，得先退出详情、开编辑落点、
 * 在树上按号码找回那个回合、选中、再点标记：绕一圈回到自己刚看的那一行。
 * 所以结构编辑（拖拽/回收站/改名/拆分）一律不进详情层，**判定这一种进**。
 *
 * ## 为什么不需要先进"编辑落点"
 *
 * 判定是**标注**，不是结构改动：它不改图、不会让枝消失，而且随时能「还原」。
 * 结构编辑要防误操作（拖错了枝就没了），标注不需要——多一次开关只会让这件事变麻烦。
 * 生效规则仍是共享层那一条：**人给的赢**，模型那份原样留着。
 */
function VerdictPicker({
  turn,
  current,
  human,
  onSet,
  onSetParent,
  onClearTwo,
  onClearParent,
}: {
  turn: number
  /** 这一回合**生效**的判定（已叠加人工修正），没判过就是 undefined。 */
  current: (SemanticVerdict & { human?: boolean }) | undefined
  /** 这条结论是不是人给的（决定「还原」是否可用、以及标记上的 `·人`）。 */
  human: boolean
  onSet: (option: { match: boolean; understanding: boolean; inScope: boolean }) => void
  /** 第三问的修正（`near`/`far`/`na`）——与上面那三档**分开**。 */
  onSetParent?: (option: 'near' | 'far' | 'na') => void
  /**
   * 各还原各的：两问的还原不该顺手抹掉父枝的判定，反之亦然
   * （原来只有一个 `onClear`，两组共用 ⇒ "还原"一次把两组都清了）。
   */
  onClearTwo: () => void
  onClearParent?: () => void
}) {
  const active = (option: { match: boolean; understanding: boolean; inScope: boolean }): boolean =>
    current !== undefined && current.match === option.match && current.understanding === option.understanding && current.inScope === option.inScope
  const buttonStyle = (on: boolean, color: string) => ({
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 10.5,
    borderRadius: 4,
    padding: '0 5px',
    border: `1px solid ${on ? color : 'color-mix(in srgb, currentColor 22%, transparent)'}`,
    background: on ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
    color: on ? color : MUTED,
    fontWeight: on ? 600 : 400,
  })
  return createElement(
    'div',
    {
      'data-intent-turn-verdict': turn,
      style: { display: 'flex', alignItems: 'baseline', gap: 5, marginTop: -4, marginBottom: 8, fontSize: 10.5, flexWrap: 'wrap' },
    },
    createElement('span', { style: { color: MUTED } }, '人工判定：'),
    ...VERDICT_PRESETS.map((option) =>
      createElement(
        'button',
        {
          key: `pick-${option.label}`,
          type: 'button',
          'data-intent-turn-verdict-set': `${turn}:${option.label}`,
          title: option.hint,
          onClick: () => onSet(option),
          style: buttonStyle(active(option), MARK_COLOR[option.label === '✓' ? 'ok' : option.label === '理解偏' ? 'understanding' : 'scope']),
        },
        option.label,
      ),
    ),
    createElement(
      'button',
      {
        type: 'button',
        'data-intent-turn-verdict-clear': turn,
        disabled: !human,
        title: human
          ? '撤销这一回合的人工判定，回到模型的结论'
          : '这一回合还没有人工判定——模型结论本来就在生效',
        onClick: onClearTwo,
        style: { ...buttonStyle(false, MUTED), opacity: human ? 1 : 0.4 },
      },
      '还原',
    ),
    // **第三问单独一组**（使用者裁定"结论分开"）：它说"挂得贴不贴"，不是"agent 对不对"。
    onSetParent === undefined
      ? null
      : createElement(
          'span',
          { 'data-intent-turn-parent': turn, style: { display: 'inline-flex', gap: 4, marginLeft: 8, alignItems: 'baseline' } },
          createElement('span', { style: { color: MUTED } }, '父枝：'),
          ...[
            { label: '近', value: 'near' as const },
            { label: '远', value: 'far' as const },
            { label: '不适用', value: 'na' as const },
          ].map((option) =>
            createElement(
              'button',
              {
                key: `parent-${option.value}`,
                type: 'button',
                'data-intent-turn-parent-set': `${turn}:${option.value}`,
                onClick: () => onSetParent(option.value),
                style: buttonStyle(current?.parent === option.value, PARENT_FAR),
              },
              option.label,
            ),
          ),
          // 父枝这一组**自己的**还原：人只改过父枝时，两问那组的"还原"不该是亮的
          createElement(
            'button',
            {
              key: 'parent-clear',
              type: 'button',
              'data-intent-turn-parent-clear': turn,
              disabled: current?.parent === undefined,
              onClick: () => onClearParent?.(),
              style: { ...buttonStyle(false, MUTED), opacity: current?.parent === undefined ? 0.4 : 1 },
            },
            '还原',
          ),
        ),
  )
}

/**
 * **详情层：一个任务节点的回合**（使用者裁定 2026-10-10：从"这一组"改成"这个节点"）。
 *
 * **两层是刻意的**：概况层回答"这段会话由哪些任务组成"（树），详情层回答
 * "这个任务里发生了什么"（逐回合）。全铺在一层就是一个很长的滚动条，
 * 读者分不清该看结构还是该看回合。
 *
 * 旧版是"一个话题组的回合"：组目标 + 派生标注 + 每回合的**组内贴合度条**。
 * 弃组之后这些组口径的东西全部下线——判据的容器是节点，展示的容器也该是节点。
 * 每行给：回合号、用户原文、以及（抽得到时）agent 当时把任务理解成了什么。
 */
function DetailLayer({
  node,
  turns,
  compactions,
  verdicts,
  latestTurn,
  verdictEdits = [],
  onVerdictEdit,
  onBack,
}: {
  node: { id: string; title: string; kind?: string } | undefined
  turns: IntentTurn[]
  compactions: IntentCompaction | undefined
  /** 逐回合的语义标记（详情层也要看得见）。 */
  verdicts?: Map<number, SemanticVerdict & { human?: boolean }>
  /** 会话里最新的回合号（标「现在」）。 */
  latestTurn?: number
  /** 人工判定（用来判断这一回合有没有被人改过 ⇒ 「还原」是否可用）。 */
  verdictEdits?: VerdictOverride[]
  /** 给了回调才渲染逐回合的人工判定（只读渲染里不出现，测试夹具不必都改）。 */
  onVerdictEdit?: (next: VerdictOverride[]) => void
  onBack: () => void
}) {
  // 这一层**只有一种编辑**：逐回合的人工判定（使用者：*"人工判定可以留在回合详情"*）。
  // 结构编辑（拖拽 / 回收站 / 改名 / 拆分）一律不进这一层——进了详情就该专心读回合。
  /**
   * **两组各写各的**（使用者 2026-10-10："人工判定和父枝的调整，好像会冲突造成选项默认化"）。
   *
   * ⚠️ 第一版只调父枝时也要编一个 `match`（写的 `current?.match ?? true`），后果是
   * **没判过的回合被调了父枝之后，标记从"未判"变成"✓·人"**——人替模型认了一个
   * 它没做过的判断。现在 `match` 在存储里可缺省，两个写入器互不覆盖：
   * 改两问保留父枝，改父枝保留两问，两组各有各的「还原」。
   */
  const writeTurnEdit = (turn: number, patch: (kept: VerdictOverride) => void): void => {
    if (onVerdictEdit === undefined) return
    const existing = verdictEdits.find((item) => item.turn === turn)
    const kept: VerdictOverride = { ...(existing ?? {}), turn }
    patch(kept)
    const rest = verdictEdits.filter((item) => item.turn !== turn)
    const empty =
      kept.match === undefined && kept.understanding === undefined && kept.inScope === undefined && kept.parent === undefined
    onVerdictEdit([...rest, ...(empty ? [] : [kept])].sort((left, right) => left.turn - right.turn))
  }
  /** 两问（理解/越界）：**保留已有的第三问**。 */
  const setTurnTwo = (
    turn: number,
    option: { match: boolean; understanding: boolean; inScope: boolean } | undefined,
  ): void =>
    writeTurnEdit(turn, (kept) => {
      if (option === undefined) {
        delete kept.match
        delete kept.understanding
        delete kept.inScope
        return
      }
      kept.match = option.match
      kept.understanding = option.understanding
      kept.inScope = option.inScope
    })
  /** 第三问：**只动 parent**（`undefined` = 只还原这一组）。 */
  const setTurnParent = (turn: number, parent: 'near' | 'far' | 'na' | undefined): void =>
    writeTurnEdit(turn, (kept) => {
      if (parent === undefined) delete kept.parent
      else kept.parent = parent
    })


  if (node === undefined) return null
  return createElement(
    'div',
    { style: { marginLeft: 6, paddingTop: 12 } },
    createElement(
      'button',
      {
        type: 'button',
        onClick: onBack,
        style: {
          fontSize: 10.5,
          padding: '2px 8px',
          marginBottom: 8,
          borderRadius: 5,
          border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        },
      },
      '← 回到结构',
    ),
    createElement(
      'div',
      {
        style: {
          borderLeft: `2px solid ${ACCENT}`,
          paddingLeft: 8,
          marginLeft: 2,
          marginBottom: 8,
        },
      },
      createElement(
        'div',
        { style: { fontSize: 11.5, fontWeight: 600, lineHeight: 1.45 } },
        node.title + (node.kind === 'aside' ? '（插话）' : ''),
      ),
      createElement(
        'div',
        { style: { fontSize: 10.5, color: MUTED } },
        `这个节点收了 ${turns.length} 个回合` + (turns.length === 0 ? '（没有回合：它是个容器）' : ''),
      ),
    ),
    // ⚠️ 一个回合要渲染**两样**（行 + 编辑器），所以 map 的返回值改成数组：
    // 直接写 `createElement(...), createElement(...)` 不在数组/片段里，`turn` 会跑出作用域
    // （tsc 当场报 "Cannot find name 'turn'"）。
    ...turns.map((turn) => {
      const verdict = verdicts?.get(turn.turn)
      const human = verdictEdits.some((item) => item.turn === turn.turn)
      return [
        createElement(TurnRow, {
          key: turn.turn,
          turn,
          compressed: isCompactionTurn(compactions, turn.turn),
          verdict,
          latest: turn.turn === latestTurn,
        }),
        // **详情层里唯一的编辑**：逐回合人工判定。
        // 结构编辑不在这一层（点在树上：拖拽 / 回收站 / 改名 / 拆分）。
        onVerdictEdit === undefined
          ? null
          : createElement(VerdictPicker, {
              key: `verdict-${turn.turn}`,
              turn: turn.turn,
              current: verdict,
              human,
              onSet: (option) => setTurnTwo(turn.turn, option),
              onSetParent: (option) => setTurnParent(turn.turn, option),
              onClearTwo: () => setTurnTwo(turn.turn, undefined),
              onClearParent: () => setTurnParent(turn.turn, undefined),
            }),
      ]
    }),
  )
}

/**
 * 会话 id 的短形式。
 *
 * **去掉 `session-` 前缀再截**：前缀占满 8 个字符，直接 `slice(0, 8)`
 * 得到的是 `"session-"`——一个对谁都无用的字符串。这条被断言抓到过。
 */
function shortSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined) return '?'
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

/** 模型主体。 */
export function IntentBody({
  model,
  compactions,
  sessionId,
  semantic,
  structure = { kind: 'idle' },
  tree = { outline: [], unattached: [] },
  graph,
  overrideCount = 0,
  prunedCount = 0,
  rejectedOverrides = [],
  saveNote,
  remapNote,
  undoDepth = 0,
  sessionTitle,
  onSessionTitleChange,
  wide = false,
  overrides = [],
  onOverridesChange,
  verdictEdits = [],
  onVerdictEdit,
  borrowed,
  initialSelection,
  initialEditing,
  initialHandoff,
  initialPicked,
}: {
  model: IntentModel
  /** 压缩事件。`undefined` = 没有数据（增强项，缺失不影响显示）。 */
  compactions: IntentCompaction | undefined
  /**
   * **生效结构**（宿主原始结构 + 人工覆盖 − 空叶子）。树与详情层都用它——
   * 面板必须显示"你已经改过的那份"，否则改完看不到效果。
   */
  graph?: TaskGraph
  /** 生效的人工覆盖条数（0 = 没改过）。 */
  overrideCount?: number
  /** 被剪掉的空叶枝数。 */
  prunedCount?: number
  /** 被拒的覆盖（带人话原因）。**必须显示**——静默拒绝等于让人以为改成功了。 */
  rejectedOverrides?: { override: TaskOverride; reason: string }[]
  /** 落盘失败要说出来（"刷新会丢"）。 */
  saveNote?: string
  /** A2 的账：按标题接回了几条旧改动（人核这一行）。 */
  remapNote?: string
  /** 撤销栈里还有几步（`Ctrl+Z` 可回退）。 */
  undoDepth?: number
  /** **宽区档**（主区对话视图传 true；侧栏不传 = 窄列）。只调版式四个数，不重排。 */
  wide?: boolean
  /** 会话里最新的回合号（标「现在」）；不传就不标。 */
  latestTurn?: number
  /** 会话名的人工覆盖（A3）。 */
  sessionTitle?: string
  onSessionTitleChange?: (next: string) => void
  /** 人工覆盖（浏览器侧持久化）。没传就是只读展示（测试夹具用）。 */
  overrides?: TaskOverride[]
  /** 覆盖变了：调用方负责落盘 + 重绘。 */
  onOverridesChange?: (next: TaskOverride[]) => void
  /** 人工修正的判定（盖住模型结论）。 */
  verdictEdits?: VerdictOverride[]
  /** 人工判定变了：调用方负责落盘 + 重绘。 */
  onVerdictEdit?: (next: VerdictOverride[]) => void
  sessionId: string | undefined
  /**
   * 语义判定的状态（走模型的**跨语言**判定）。
   *
   * 它判的是"这条理解的意图与所在组是不是同一件事"——**字面判据看不见的那类**：
   * 词面还像（工具名、文件名都在），意图已经变了。
   */
  semantic?: SemanticState
  /** 任务结构那条路的状态（与语义核查各自独立）。 */
  structure?: StructureState
  /** 折叠树 + 没挂任何节点的回合（由 tab 层用 shared 的 treeRows+nestRows 算好传进来）。 */
  tree?: { outline: TreeOutline[]; unattached: number[] }
  /**
   * 显示的会话**不是**当前作用域里的那个（应用层打开 tab，没有选中会话）。
   *
   * 那时必须**显式标注**：一份"别人的意图"看起来和"你的意图"一模一样，
   * 不说出来就是个看起来像答案的错答案。
   */
  borrowed?: boolean
  /**
   * 初始选中的组。**只给测试用**。
   *
   * 存在的理由：`renderToStaticMarkup` 不会执行状态更新，所以"点开一个组"
   * 这个交互在离线渲染里到不了。没有这个入口，详情层就**无法被验证**——
   * 而"能不能验证"决定了 bug 是被测出来还是被用户撞出来（这条教训本项目吃过两次）。
   */
  initialSelection?: string
  /** 初值：直接进编辑态（测试用；界面上的入口是「编辑落点」按钮）。 */
  initialEditing?: boolean
  /** **交接摘要**：测试要能直接渲染预览层（与 `initialSelection` 同一套做法）。 */
  initialHandoff?: boolean
  /** 预置的选中回合（测试用：整枝铺开之后的样子）。 */
  initialPicked?: number[]
}) {
  // **两层**：`undefined` = 概况层；有值 = 该组的详情层。
  // **两层**：`undefined` = 结构层（树）；有值 = 该**节点**的详情层。
  // 旧版这里是话题组 id —— 弃组之后选中对象换成任务节点。
  const [selected, setSelected] = useState<string | undefined>(initialSelection)
  /**
   * **编辑态**（方案 A）：默认只读，面板干净；打开后点回合行=选中（可多选），
   * 顶部出现固定操作栏。**不做"改动清单"**——按使用者选择保持界面简洁，
   * 改动仍由行上的「改过」徽标与单条还原体现。
   */
  // **可注入的初值**（与 `initialSelection` 同一套做法）：测试要能渲染**编辑态**。
  // 此前所有"编辑态才出现"的断言都只能停在源码级（静态渲染进不去编辑态），
  // 于是"编辑态下这些行到底长什么样"从来没被看过一眼——这一轮的拖拽问题就出在这里。
  const [editing, setEditing] = useState(initialEditing ?? false)
  const [picked, setPicked] = useState<number[]>(initialPicked ?? [])
  /**
   * **交接摘要**（使用者："多选枝或回合 → 快速总结信息，用于创建独立 session"）。
   *
   * 两条裁定落在这一层：**不替你建会话**（只把文本交给你：复制/下载），
   * 带枝名就必须**保留结构**（`withTitles` 开关，草稿由 `shared/handoff` 生成）。
   */
  const [handoffOpen, setHandoffOpen] = useState(initialHandoff ?? false)
  const [handoffWithTitles, setHandoffWithTitles] = useState(true)
  /** 用户编辑过的正文；`undefined` = 还没动过（显示刚生成的草稿）。 */
  const [handoffEdited, setHandoffEdited] = useState<string | undefined>(undefined)
  const [handoffNote, setHandoffNote] = useState<string | undefined>(undefined)
  /** 精炼在飞（按钮禁用，避免连点烧钱）。 */
  const [handoffBusy, setHandoffBusy] = useState(false)
  /** 「选中整枝…」的选择器展开着吗。 */
  const [branchPicker, setBranchPicker] = useState(false)
  /** 宽区里被**手动收起**的区间（键 `节点id:起始下标`）；默认展开。 */
  const [collapsedRanges, setCollapsedRanges] = useState<Set<string>>(new Set())
  /** 「新建枝…」的名字草稿（undefined = 输入框没打开）。 */
  const [branchDraft, setBranchDraft] = useState<string | undefined>(undefined)
  const [picker, setPicker] = useState<'attach' | undefined>(undefined)
  /** 正在拖的回合（若拖的那条在选中集里，就整批一起拖）+ 当前悬停的节点。 */
  const [dragging, setDragging] = useState<number[]>([])
  /** 拖拽的**源节点**（那一行所在的节点）——落点时要把它去掉。 */
  const [draggingFrom, setDraggingFrom] = useState<string | undefined>(undefined)
  /** 正在拖的枝条（节点 id）：落到别的枝条 = 合并，落到投放区 = 删除。 */
  const [draggingNode, setDraggingNode] = useState<string | undefined>(undefined)
  /**
   * **最近一次"回收"动作**（用于给一个撤销入口）。
   *
   * 使用者不要常驻的改动清单（保持简洁），但回收站是破坏性的 ⇒ 必须给退路。
   * 两种对象都记：枝条（删除）与回合（摘除落点，记下它原来挂在哪儿才能放回去）。
   */
  /** 树上的节点面板（改名 / 拆分）。 */
  const [nodePanel, setNodePanel] = useState<{ id: string; kind: 'rename' | 'split' | 'merge' } | undefined>(undefined)
  const [nodeDraft, setNodeDraft] = useState('')
  const [nodePicks, setNodePicks] = useState<string[]>([])
  /** 拆分面板里勾选的**回合**（"有回合就能拆"）。 */
  const [nodeTurnPicks, setNodeTurnPicks] = useState<number[]>([])
  const [lastRecycled, setLastRecycled] = useState<
    | { kind: 'branch'; id: string; title: string }
    | { kind: 'turns'; entries: { turn: number; nodes: string[] }[] }
    | undefined
  >(undefined)
  const [hoverNode, setHoverNode] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')

  // 目标时间线：官方 `goal` 投影只有当前值，这份历史是我们自己 fold 出来的。
  const goalTimeline = model.goalTimeline ?? []

  // 模型判定按回合号索引，渲染时 O(1) 取。
  const verdicts = new Map<number, SemanticVerdict>()
  /**
   * **生效判定 = 模型结论 + 人工修正**（人给的赢）。计数与逐回合标记都按这份算——
   * 否则"我把它改成没问题了，计数却还说有问题"。唯一规则在共享层的
   * `applyVerdictOverrides`（宿主/浏览器/测试共用）。
   */
  const verdictsEffective: (SemanticVerdict & { human?: boolean; note?: string })[] = applyVerdictOverrides(
    semantic?.kind === 'done' ? semantic.result.verdicts : [],
    verdictEdits,
  )
  for (const verdict of verdictsEffective) verdicts.set(verdict.turn, verdict)
  const mismatches = [...verdicts.values()].filter((verdict) => verdict.match === false).length
  /**
   * **两问分开报**（理解偏 / 越界）：一句"落点不清楚"说不清是哪种，
   * 而两者的处置完全不同——理解偏了要重说一遍任务，越界了只要把它挪回界内。
   */
  const understandingOff = [...verdicts.values()].filter((verdict) => verdict.understanding === false).length
  const outOfScope = [...verdicts.values()].filter((verdict) => verdict.inScope === false).length
  /** 第三问：与父枝较远 / 偏出领域的条数（**单独报**，不并进"有问题"那个数）。 */
  const farFromParent = [...verdicts.values()].filter((verdict) => verdict.parent === 'far').length
  /**
   * **没给出第三问的条数**：实测材料单调重复时模型会**整批不写** parent
   * （12 条 0 条给），而界面上只表现为"这些回合没有 ↔较远"——看不出是漏了。
   * 与 `want/got` 那条教训同源：不量它、不说它，就等于没有这条判据。
   */
  const missingParent = [...verdicts.values()].filter((verdict) => verdict.parent === undefined).length
  /** 其中"全票一致"的条数——比多数票硬，值得单独说。 */
  /** 人工修正过几条（说明"这个数字里有人的判断"）。 */
  const humanCount = [...verdicts.values()].filter((verdict) => (verdict as { human?: boolean }).human === true).length
  const unanimousMismatches = [...verdicts.values()].filter(
    (verdict) => verdict.match === false && verdict.votes !== undefined && verdict.votes === verdict.total,
  ).length

  // **选中的节点可能已经不存在了。**
  //
  // 结构会随内容重算——节点是派生物，换个内容就会重切，旧 id 随之消失。
  // 那时 `DetailLayer` 返回 null，而概况层因为 `selected !== undefined` 也不渲染，
  // 于是**面板整个空白，而且连"回到概况"的按钮都没有**——那个按钮在详情层里。
  //
  // 所以这里先判定它还在不在，不在就当作没选中。
  //
  // 节点内要显示"它收的对话"，所以这里建一张表：回合 → 原文
  /** 生效的覆盖（被拒的那些不参与"改过 N 条"的账）。 */
  const rejectedSet = new Set<unknown>(rejectedOverrides.map((item) => item.override))
  const appliedOverrides = overrides.filter((item) => !rejectedSet.has(item))
  /**
   * **标题查表：先查宿主原始结构，再查生效结构。**
   *
   * 被删掉的枝条**只在原始结构里还有名字**——只查生效结构的话，摘要会写成
   * `删枝条 「t21」`（生 id），而使用者认不出那是哪一枝。使用者的诊断块里
   * 正好出现了这一条：`删枝条 「t21」/「t23」`，两枝都已不在节点表里。
   */
  const titleGraph: TaskGraph = {
    nodes: { ...(structure.structure?.nodes ?? {}), ...(graph?.nodes ?? {}) },
    membership: {},
  }

  const turnText = new Map<number, string>()
  for (const turn of model.turns) {
    if (turn.prompt.trim() !== '') turnText.set(turn.turn, turn.prompt)
  }

  // 回退视图要按会话顺序列回合（结构不可用时用它，不发明划分）
  const chronologicalTurns = model.turns
    .map((turn) => ({ turn: turn.turn, text: turn.prompt }))
    .filter((item) => item.text !== '')
    .sort((left, right) => left.turn - right.turn)

  // 选中的节点 + 它名下的回合（回合来自结构，文本来自投影）
  const activeNode =
    selected !== undefined && structure.kind === 'done' && (graph ?? structure.structure)?.nodes[selected] !== undefined
      // 节点表里没有内层 id（它以 id 为键），补上再交给详情层
      ? { id: selected, ...(graph ?? structure.structure)!.nodes[selected] }
      : undefined
  const activeNodeTurns: IntentTurn[] = (() => {
    if (activeNode === undefined) return []
    const turnNumbers = (Object.entries((graph ?? structure.structure)?.membership ?? {}) as [string, string[]][])
      .filter(([, list]) => list.includes(selected as string))
      .map(([turn]) => Number(turn))
      .sort((left, right) => left - right)
    const byTurn = new Map<number, IntentTurn>()
    for (const turn of model.turns) byTurn.set(turn.turn, turn)
    return turnNumbers.map((turn) => byTurn.get(turn)).filter((turn): turn is IntentTurn => turn !== undefined)
  })()
  const showingDetail = activeNode !== undefined
  /**
   * **节点行 / 未挂载行共用的上下文**（同一个 `turnRowElement` 渲染器）。
   *
   * 使用者 2026-10-10：*"独立回合还是没有显示，这让我如何进行挂接已有枝或新枝？"*
   * ——此前「没挂任何节点」只有一串号码：看得见，但既不能点选、也不能拖，
   * 于是**没有任何办法把独立回合挂回枝上**。现在那一区渲染成真正的回合行。
   */
  const layout = layoutFor(wide)
  /** 会话里最新的回合号：标「现在」用（`model.turns` 未必有序，取最大值）。 */
  const latestTurn = model.turns.length === 0 ? undefined : Math.max(...model.turns.map((t) => t.turn))
  /**
   * **回合号 → 挂了它的枝（标题）**：给回合行上的 `×N` 用。
   * 数据来自生效结构的 membership（人工覆盖之后的那份，与树一致）。
   */
  const turnPlaces = new Map<number, string[]>()
  for (const [turnKey, ids] of Object.entries(graph?.membership ?? {})) {
    const titles = (ids ?? []).map((id) => String(graph?.nodes[id]?.title ?? id))
    if (titles.length > 0) turnPlaces.set(Number(turnKey), titles)
  }
  /**
   * **最新回合的祖先链**：从挂它的节点出发，沿 `parents` 往上走到顶（排除 `root`——它不是节点）。
   * 用 BFS 防环（多父 + 人工编辑都可能造出环，渲染侧有 ↻ 环 的兜底，这里也不能死循环）。
   */
  const nowPath = new Set<string>()
  if (latestTurn !== undefined) {
    const queue = [...(graph?.membership[String(latestTurn)] ?? [])]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (id === 'root' || nowPath.has(id)) continue
      nowPath.add(id)
      for (const parent of graph?.nodes[id]?.parents ?? []) queue.push(parent)
    }
    // 直接挂着它的节点走 `data-intent-node-latest` 那条标记，避免同一条枝上叠两个徽标
    for (const id of graph?.membership[String(latestTurn)] ?? []) nowPath.delete(id)
  }
  /**
   * **碎片信号：只收一个回合的枝。**
   *
   * 为什么要有它：增量归属的默认行为是"分不清就新建节点"，长期会长出一堆单回合节点，
   * 而两条自动收拢的路都不动它——判整理实测是**空操作**（8/8 次 `节点 X → X`）、
   * 定期根裁定只管"多条顶层线"（单线会话上是空开关）。
   * 所以先把这件事**显示出来**（枝上一枚 `·1` 徽标 + 概览层一行汇总），
   * 由人用现成的「合并到…」决定要不要并——**自动改结构之前必须先有可观测的口径**
   * （同材料两跑方差可达 30%，在噪声上下注没有意义）。
   */
  const turnsPerNode = new Map<string, number>()
  for (const ids of Object.values(graph?.membership ?? {})) {
    for (const id of ids ?? []) turnsPerNode.set(id, (turnsPerNode.get(id) ?? 0) + 1)
  }
  const hasChild = new Set<string>()
  for (const node of Object.values(graph?.nodes ?? {})) {
    for (const parent of node?.parents ?? []) hasChild.add(parent)
  }
  /**
   * 口径：**叶子 + 只收一个回合**。
   * 有子节点的容器即使自己只挂 1 个回合也**不算**——那是正常容器，不是要合并的对象
   * （把容器也标上会让整棵树都是虚线徽标，信号就没了）。
   */
  const singleTurnNodes = new Set(
    Object.keys(graph?.nodes ?? {}).filter((id) => turnsPerNode.get(id) === 1 && !hasChild.has(id)),
  )
  /**
   * **交接摘要**的材料与草稿（阶段 1：确定性、秒出、免费）。
   *
   * 材料口径与语义核查一致（用户指令 + agent 自述理解），但**只带选中的回合**；
   * 结构骨架用树上那份 `outline`（含 `depth`），所以"带枝名"时层级是原样的。
   */
  const handoffTurns = (model?.turns ?? [])
    .filter((turn) => picked.includes(turn.turn))
    .map((turn) => ({
      turn: turn.turn,
      task: (graph?.membership[String(turn.turn)] ?? [])
        .map((id) => String(graph?.nodes[id]?.title ?? ''))
        .filter((title) => title !== '')
        .join(' / '),
      ask: String(turn.prompt ?? ''),
      did: String(turn.response ?? ''),
    }))
  const handoffOutline = tree.outline.map((node) => ({
    id: node.row.id,
    title: String(node.row.title ?? ''),
    depth: node.row.depth ?? 0,
    turns: node.row.turns ?? [],
  }))
  // "整枝拿全"的枝数（只用于写账；选择集本身只有回合，见 shared/handoff 的说明）
  const handoffNodes = fullySelectedNodes(
    graph?.nodes ?? {}, graph?.membership ?? {}, Object.keys(graph?.nodes ?? {}), picked,
  )
  const handoff = handoffDraft(
    {
      sessionId: sessionId ?? '',
      sessionTitle,
      turns: handoffTurns,
      outline: handoffOutline,
      nodeIds: handoffNodes,
    },
    { withTitles: handoffWithTitles },
  )
  /** 用户改过就用改过的；没改过就显示刚生成的草稿（改过之后不被重新生成覆盖）。 */
  const handoffText = handoffEdited ?? handoff.text
  const branchOptions = handoffOutline
  /**
   * **复制**：剪贴板可能不可用（无权限 / 非安全上下文），所以失败时**必须给退路**
   * ——告诉人"手动全选文本框"，绝不假装成功。
   */
  const copyHandoff = (): void => {
    const holder = globalThis as {
      navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } }
    }
    const write = holder.navigator?.clipboard?.writeText
    if (write === undefined) {
      setHandoffNote('这个环境没有剪贴板接口——请手动全选文本框内容复制')
      return
    }
    void write
      .call(holder.navigator?.clipboard, handoffText)
      .then(() => setHandoffNote('已复制到剪贴板'))
      .catch(() => setHandoffNote('复制被浏览器拒绝——请手动全选文本框内容复制'))
  }
  /**
   * **用模型精炼**（阶段 2）：把草稿交给宿主那条 `/api/intent.handoff` 重写成
   * "目标 / 已定结论 / 关键约束 / 未决 / 建议第一步"。
   *
   * 三条刻意的做法：
   * 1. **材料就是草稿本身**（不再送一遍逐回合材料，token 省一半）；
   * 2. **失败保留草稿**——精炼只是"更好读"，不是"必需"（使用者裁定：不丢东西）；
   * 3. **显示耗时**——这一步要花钱和时间，账要露出来。
   */
  const refineHandoff = (): void => {
    if (handoffBusy) return
    setHandoffBusy(true)
    setHandoffNote('正在精炼…')
    const started = Date.now()
    void (async () => {
      try {
        const response = await fetch(HANDOFF_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, draft: handoffText, withTitles: handoffWithTitles }),
        })
        const read = await readJsonBody<{
          ok?: boolean
          text?: string
          error?: string
          meta?: { elapsedMs?: number; model?: string }
        }>(response)
        const payload = read.data ?? { error: read.error ?? '响应读不出来' }
        if (payload.ok === true && typeof payload.text === 'string' && payload.text.trim() !== '') {
          setHandoffEdited(payload.text)
          const seconds = ((payload.meta?.elapsedMs ?? Date.now() - started) / 1000).toFixed(1)
          setHandoffNote(
            `已精炼（${seconds} 秒 · ${payload.meta?.model ?? ''}）` +
              '——想回到草稿：点一下「带枝名称」开关（它会重新生成草稿）',
          )
        } else {
          setHandoffNote(`没精炼成（${String(payload.error ?? '未知原因').slice(0, 80)}）——**保留草稿**`)
        }
      } catch (error) {
        setHandoffNote(
          `没精炼成（${String((error as Error)?.message ?? error).slice(0, 60)}）——**保留草稿**`,
        )
      } finally {
        setHandoffBusy(false)
      }
    })()
  }

  /** **下载 .md**：给"存下来再贴"的用法兜底（剪贴板之外的第二条出口）。 */
  const downloadHandoff = (): void => {
    try {
      const view = globalThis as unknown as {
        Blob: new (parts: string[], options: { type: string }) => unknown
        URL: { createObjectURL: (blob: unknown) => string; revokeObjectURL: (url: string) => void }
        document: { createElement: (tag: string) => { href: string; download: string; click: () => void } }
      }
      const url = view.URL.createObjectURL(new view.Blob([handoffText], { type: 'text/markdown' }))
      const anchor = view.document.createElement('a')
      anchor.href = url
      anchor.download = `handoff-${(sessionId ?? 'session').slice(0, 8)}.md`
      anchor.click()
      view.URL.revokeObjectURL(url)
      setHandoffNote('已下载 .md')
    } catch (error) {
      setHandoffNote(`下载失败（${String((error as Error)?.message ?? error).slice(0, 40)}）——请手动复制文本框内容`)
    }
  }

  const nodeRowContext = {
    nowPath,
    singleTurn: singleTurnNodes,
    turnPlaces,
    rangeSize: layout.rangeSize,
    collapsedRanges,
    onToggleRange: (rangeKey: string) =>
      setCollapsedRanges((current) => {
        const next = new Set(current)
        if (next.has(rangeKey)) next.delete(rangeKey)
        else next.add(rangeKey)
        return next
      }),
    latestTurn,
    snippetLen: layout.snippet,
    turnPreview: layout.preview,
    turnText,
    verdicts,
    // 未挂载行不进详情：它还没有节点可进（树上的行仍由各节点自己的 onOpenNode 覆盖）
    onOpenNode: (nodeId: string) => setSelected(nodeId),
    editing: editing && onOverridesChange !== undefined,
    selected: new Set(picked),
    onToggleTurn: (turn: number) => setPicked((current) => toggleTurn(current, turn)),
    /**
     * ⚠️ **拖拽处理器必须也在这里**（树上与独立回合共用这一份）。
     *
     * 第一版只把它们放进了树上节点那一份 props，于是独立回合虽然 `draggable=true`、
     * 鼠标也能拖起来，但 `context.onDragStart` 是 `undefined`——**没写 dataTransfer、
     * 也没置状态**，落点读到的永远是空的 ⇒ "拖起来没反应"。
     * 使用者 2026-10-10：*"独立回合用复制到按钮可以挂，但是直接拖动挂不了"*。
     */
    onDragStart: (turn: number, fromNode: string, event?: DragLike) => {
      const turns = picked.includes(turn) && picked.length > 1 ? picked : [turn]
      // 载荷写进 dataTransfer：落点读到的是"按下鼠标那一刻"的事实，
      // 不再依赖 React 状态有没有被同一次事件链里的别的处理器覆盖。
      event?.dataTransfer?.setData?.(DRAG_MIME, encodeDrag(turns, fromNode))
      if (event?.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
      setDragging(turns)
      setDraggingFrom(fromNode)
    },
    onDragEnd: () => {
      setDragging([])
      setDraggingFrom(undefined)
    },
  }
  return createElement(
    'div',
    {
      style: {
        ...SCROLL,
        padding: layout.padding,
        ...(layout.maxWidth === undefined ? {} : { maxWidth: layout.maxWidth, margin: '0 auto' }),
        fontSize: 12,
        lineHeight: 1.5,
      },
    },
    borrowed === true
      ? createElement(
          'div',
          {
            'data-intent-borrowed': 'true',
            style: {
              marginBottom: 10,
              padding: '7px 9px',
              border: `1px dashed ${MUTED}`,
              borderRadius: 6,
              color: MUTED,
              fontSize: 11,
              lineHeight: 1.5,
            },
          },
          `⚠ 当前没有选中的会话，这里显示的是 **${shortSessionId(sessionId)}** ——` +
            '不是你可能以为的那个会话。在左侧选一个会话再打开本面板。',
        )
      : null,
    createElement(
      'div',
      {
        style: {
          border: `1.5px solid ${ACCENT}`,
          borderRadius: 8,
          padding: '8px 10px',
          marginBottom: 4,
          background: 'color-mix(in srgb, currentColor 4%, transparent)',
        },
      },
      createElement(
        'div',
        { style: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 } },
        model.rootLabel,
      ),
      createElement(
        'div',
        {
          style: {
            fontSize: 10.5,
            color: MUTED,
            marginTop: 3,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          },
        },
        createElement('span', null, model.rootDetail),
        createElement(
          'span',
          {
            title:
              model.rootProvenance === 'derived'
                ? '读自会话的 goal 投影'
                : '会话标题不是作者声明的目标，标为推断',
            style: { color: model.rootProvenance === 'inferred' ? LOW : MUTED },
          },
          model.rootProvenance === 'derived' ? 'derived' : 'inferred',
        ),
        createElement('span', null, `${model.turnCount} 回合`),
        // 「基线：…」那个标签已删（B4-4）：它标注的"参与比较的基线"随贴合度一起下线了，
        // 名字与实际作用（只是头部标题的来源）早已不符。来源仍由上面的 derived/inferred 标注。
      ),
      // **目标时间线** —— 官方 `goal` 投影只有当前值，没有历史。
      // 这里显示"目标何时建立、改过几次"，因为那正是判断"这一段在做什么"的关键。
      goalTimeline.length > 0
        ? createElement(
            'div',
            {
              style: {
                fontSize: 10.5,
                color: MUTED,
                marginTop: 4,
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                alignItems: 'baseline',
              },
            },
            createElement(
              'span',
              {
                title:
                  '判据：`goal/change` 事件的真实回合号（它不是 `roundsStarted`，' +
                  '那是目标寿命内的计数——把它当回合号用会错得离谱）',
                style: { fontWeight: 600 },
              },
              `目标时间线 ${goalTimeline.length} 次`,
            ),
            ...goalTimeline.slice(-6).map((entry, index) =>
              createElement(
                'span',
                {
                  key: `${entry.turn}-${entry.operation}-${index}`,
                  title: `第 ${entry.turn} 回合 · ${operationLabel(entry.operation)}` +
                    (entry.revision === null ? '' : ` · 第 ${entry.revision} 版`),
                  style: {
                    fontVariantNumeric: 'tabular-nums',
                    color: entry.operation === 'create' ? ACCENT : MUTED,
                    fontWeight: entry.operation === 'create' ? 600 : 400,
                  },
                },
                `#${entry.turn}${operationMark(entry.operation)}`,
              ),
            ),
            goalTimeline.length > 6
              ? createElement('span', null, `… 另有 ${goalTimeline.length - 6} 次`)
              : null,
          )
        : null,
      compactionCount(compactions) > 0
        ? createElement(
            'div',
            {
              title: '压缩事件来自宿主投影（compaction/start 事件自带 turn）',
              style: { fontSize: 10.5, color: COMPACT, marginTop: 6 },
            },
            `本会话压缩 ${compactionCount(compactions)} 次 · 落在 ` +
              `${(compactions?.compactionTurns ?? []).map((value: number) => `#${value}`).join(' ')}`,
          )
        : null,
      // 头部不再有"编辑基线"（B4-4 已删）：**改名走覆盖系统**——
      // 想改哪个节点的名字，开「编辑落点」，在该节点行末尾点「改名」（逐会话持久化）。
      //
      // 两句都只给概况层。⚠️ 头两句原先写的是"详情层「改名」"——详情层早已清成只读，
      // 等于把人指向一个不存在的按钮；而且这条提示本身会渲染进详情层，
      // 让读者以为那一层还能编辑（使用者 2026-10-10 反馈"详情里还能看到编辑按钮栏"）。
      // 现在详情层里**一句编辑相关的话都没有**，断言盯着它。
      !showingDetail
        ? createElement(
            'div',
            { 'data-intent-session-title': applySessionTitle(model.rootDetail, sessionTitle), style: { fontSize: 10.5, color: MUTED, marginTop: 4 } },
            `会话名：${applySessionTitle(model.rootDetail, sessionTitle)}`,
            sessionTitle === undefined ? '' : '（人工改的）',
            // **就地改会话名**（A3）：结构里没有 root 节点，所以走独立的键存一个字符串。
            // 只在编辑态给入口，与树上节点改名的规矩一致。
            editing && onSessionTitleChange !== undefined && onOverridesChange !== undefined
              ? createElement('input', {
                  'data-intent-session-title-input': 'on',
                  defaultValue: applySessionTitle(model.rootDetail, sessionTitle),
                  placeholder: '改成什么？（清空 = 还原）',
                  onKeyDown: (event: { key: string; target: { value: string } }) => {
                    if (event.key !== 'Enter') return
                    onSessionTitleChange?.(event.target.value)
                  },
                  style: { font: 'inherit', fontSize: 10.5, marginLeft: 6, width: 180 },
                })
              : null,
          )
        : null,
    ),

    // ── 概况层 ──────────────────────────────────────────────────────────
    //
    // **面板分成两层。**
    //
    // 之前是"14 个组 + 198 个回合"全铺在一个滚动条里——那是把详细层全量呈现，
    // 面板因此很长，读者分不清"该看结构"还是"该看回合"。
    !showingDetail
      ? createElement(
          'div',
          { style: { marginLeft: 6, paddingTop: 14 } },
          createElement(
            'div',
            {
              style: {
                fontSize: 10.5,
                fontWeight: 600,
                color: MUTED,
                letterSpacing: '0.02em',
                margin: '14px 0 8px',
              },
            },
            // **树是主体**（使用者裁定：扁平的话题组列表不要了，对话放在节点里看）。
            // 标题只说这一层是什么，不重复树里已有的计数——节点数、分叉点都在树上。
            createElement(
              'span',
              null,
              '任务结构（一个回合可以落在多个任务上）',
              createElement(
                'span',
                { 'data-intent-legend': 'true', style: { fontWeight: 400, color: MUTED, marginLeft: 6 } },
                '· 每行末尾的 ⟨⟩ 是语义标记：✓ 正常 / 理解偏 / 越界 / 未判（点击回合行可看该节点详情）',
              ),
            ),
          ),
          branchPicker && editing
            ? createElement(
                'div',
                {
                  'data-intent-branch-picker': branchOptions.length,
                  style: {
                    marginBottom: 8, padding: '6px 9px', borderRadius: 6, fontSize: 11.5,
                    border: `1px solid ${ACCENT}`, background: 'color-mix(in srgb, #2e6fd9 6%, transparent)',
                  },
                },
                createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '点一个枝 = 把整棵子树的回合铺进选择：'),
                ...branchOptions.map((node) =>
                  createElement(
                    'button',
                    {
                      key: node.id,
                      type: 'button',
                      'data-intent-branch-option': node.id,
                      onClick: () =>
                        setPicked((current) =>
                          toggleBranch(
                            current,
                            subtreeTurns(graph?.nodes ?? {}, graph?.membership ?? {}, node.id),
                          ),
                        ),
                      style: {
                        display: 'block', textAlign: 'left', width: '100%', cursor: 'pointer',
                        font: 'inherit', border: 'none', background: 'transparent', color: 'inherit',
                        padding: `2px 0 2px ${8 + node.depth * 12}px`,
                      },
                    },
                    // ⚠️ 标签必须报**整棵子树**的回合数：点击动作铺的是子树，
                    // 而 `row.turns` 对容器可能只算它自己直接收的那几条——
                    // 第一版显示"1 回合"却铺进 83 条，看着像 bug（实测踩到）。
                    `${node.title === '' ? node.id : node.title}（${
                      subtreeTurns(graph?.nodes ?? {}, graph?.membership ?? {}, node.id).length
                    } 回合）`,
                  ),
                ),
              )
            : null,
          handoffOpen
            ? createElement(
                'div',
                {
                  'data-intent-handoff': picked.length,
                  style: {
                    marginBottom: 10, padding: '8px 10px', borderRadius: 6, fontSize: 11.5,
                    border: `1px solid ${ACCENT}`, background: 'color-mix(in srgb, #2e6fd9 5%, transparent)',
                  },
                },
                createElement(
                  'div',
                  { style: { fontWeight: 600, marginBottom: 2 } },
                  `交接摘要 · ${picked.length} 回合 · 整枝 ${handoffNodes.length} 枝 · ${handoffText.length} 字`,
                ),
                createElement(
                  'div',
                  { style: { color: MUTED, marginBottom: 4 } },
                  '这是**一份快照**（源会话之后的更新不会同步）；**不会替你建会话**——复制或下载后自己贴到新会话里。',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-handoff-titles': handoffWithTitles ? 'on' : 'off',
                    onClick: () => {
                      setHandoffWithTitles((value) => !value)
                      setHandoffEdited(undefined)
                    },
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  handoffWithTitles ? '带枝名称（保留结构）✓' : '带枝名称（保留结构）',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-handoff-refine': handoffBusy ? 'busy' : 'idle',
                    disabled: handoffBusy,
                    onClick: refineHandoff,
                    style: {
                      cursor: handoffBusy ? 'default' : 'pointer', font: 'inherit',
                      padding: '0 8px 0 0', border: 'none', background: 'transparent',
                      color: 'inherit', textDecoration: 'underline',
                    },
                  },
                  handoffBusy ? '正在精炼…' : '用模型精炼',
                ),
                createElement(
                  'button',
                  {
                    type: 'button', 'data-intent-handoff-copy': '1', onClick: copyHandoff,
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '复制',
                ),
                createElement(
                  'button',
                  {
                    type: 'button', 'data-intent-handoff-download': '1', onClick: downloadHandoff,
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '下载 .md',
                ),
                createElement(
                  'button',
                  {
                    type: 'button', 'data-intent-handoff-close': '1', onClick: () => setHandoffOpen(false),
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '关闭',
                ),
                handoffNote === undefined
                  ? null
                  : createElement(
                      'div',
                      { 'data-intent-handoff-note': handoffNote.slice(0, 40), style: { color: COMPACT, marginTop: 2 } },
                      handoffNote,
                    ),
                createElement('textarea', {
                  'data-intent-handoff-text': handoffText.length,
                  value: handoffText,
                  rows: 16,
                  onChange: (event: { target?: { value?: unknown } }) =>
                    setHandoffEdited(String(event?.target?.value ?? '')),
                  style: {
                    width: '100%', marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    fontSize: 11, lineHeight: 1.5, padding: 6, borderRadius: 4,
                    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                    background: 'transparent', color: 'inherit',
                  },
                }),
              )
            : null,
          tree.outline.length > 0
            ? createElement(
                'div',
                { 'data-intent-outline': tree.outline.length, style: { fontSize: 11.5, lineHeight: 1.6 } },
                ...tree.outline.map((node, index) =>
                  structureNode(node, `n${index}`, {
                    ...nodeRowContext,
                    dragging,
                    draggingNode,
                    onNodeDragStart: (nodeId: string) => {
                      setDraggingNode(nodeId)
                      setDragging([])
                    },
                    // 拖拽处理器在 `nodeRowContext` 里（树上与独立回合共用同一份，
                    // 两处各写一份就是这次的坑：独立回合那份漏了，拖起来没反应）
                    onDragEnd: () => {
                      setDragging([])
                      setDraggingFrom(undefined)
                      setDraggingNode(undefined)
                      setHoverNode(undefined)
                    },
                    hoverNode,
                    onHoverNode: setHoverNode,
                    graph,
                    // `graph` 就是**生效结构**（IntentBody 的 prop），membership 直接从它取
                    membership: graph?.membership ?? {},
                    nodePanel,
                    onOpenNodePanel: (id: string, kind: 'rename' | 'split' | 'merge' | undefined) => {
                      setNodePanel(kind === undefined ? undefined : { id, kind })
                      setNodeDraft('')
                      setNodePicks([])
                      setNodeTurnPicks([])
                    },
                    nodeDraft,
                    onNodeDraft: setNodeDraft,
                    nodePicks,
                    onToggleNodePick: (id: string) =>
                      setNodePicks((current) =>
                        current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
                      ),
                    nodeTurnPicks,
                    onToggleNodeTurnPick: (turn: number) =>
                      setNodeTurnPicks((current) =>
                        current.includes(turn) ? current.filter((x) => x !== turn) : [...current, turn],
                      ),
                    onCommitMergeInto: (id: string, into: string) => {
                      if (id !== into) onOverridesChange?.([...overrides, { op: 'merge', from: [id], into }])
                      setNodePanel(undefined)
                    },
                    onDeleteNode: (id: string) => {
                      // 与回收站同一条 op；撤销走 Ctrl+Z（撤销栈）或回收站那颗按钮
                      onOverridesChange?.([...overrides, { op: 'delete', id }])
                    },
                    onCommitRename: (id: string, title: string) => {
                      if (title === '') return
                      onOverridesChange?.([...overrides, { op: 'rename', id, title }])
                      setNodePanel(undefined)
                    },
                    onCommitSplit: (id: string, title: string, picks: { turns: number[]; children: string[] }) => {
                      if (title === '' || (picks.turns.length === 0 && picks.children.length === 0)) return
                      const newId = `s${Date.now().toString(36)}`
                      onOverridesChange?.(splitBranch(overrides, graph, id, newId, title, picks))
                      setNodePanel(undefined)
                    },
                    onDropOn: (nodeId: string, event?: DragLike) => {
                      // **先读载荷**（可靠），React 状态只作后备
                      const carried = decodeDrag(event?.dataTransfer?.getData?.(DRAG_MIME))
                      if (carried !== undefined) {
                        onOverridesChange?.(dropOnNode(overrides, graph, carried, nodeId))
                        setDragging([])
                        setDraggingFrom(undefined)
                        setDraggingNode(undefined)
                        setHoverNode(undefined)
                        return
                      }
                      // **拖着枝条**落到这条枝上 ⇒ 合并（把源枝并进目标枝）
                      if (draggingNode !== undefined) {
                        if (draggingNode !== nodeId) {
                          onOverridesChange?.([...overrides, { op: 'merge', from: [draggingNode], into: nodeId }])
                        }
                        setDraggingNode(undefined)
                        setHoverNode(undefined)
                        return
                      }
                      if (dragging.length === 0 || draggingFrom === undefined) return
                      // **`draggingFrom === ''` = 从"没挂任何节点"那一区拖来的**：
                      // 没有源节点可去掉 ⇒ 落点是**挂上去**（追加），不是替换。
                      onOverridesChange?.(
                        draggingFrom === ''
                          ? attachTurns(overrides, graph, dragging, nodeId)
                          : moveTurns(overrides, graph, dragging, draggingFrom, nodeId),
                      )
                      setDragging([])
                      setDraggingFrom(undefined)
                      setHoverNode(undefined)
                    },
                    onOpenNode: (nodeId: string) => setSelected(nodeId),
                  }),
                ),
              )
            : createElement(
                'div',
                { 'data-intent-fallback': structure.kind, style: { fontSize: 11.5 } },
                createElement(
                  'div',
                  { style: { color: MUTED, marginBottom: 6 } },
                  structure.kind === 'running'
                    ? '正在算任务结构…（算完后这里是一棵按任务的树；下面是这一会话的回合，按顺序）'
                    : structure.kind === 'failed'
                      ? `任务结构没算成（${structure.error ?? ''}）——下面是这一会话的回合，按顺序`
                      : '还没有任务结构（需要模型；一次会话第一次打开时算一次）——下面是这一会话的回合，按顺序',
                ),
                // **回退视图 = 按会话顺序列回合**（使用者裁定：面板按会话顺序列即可）。
                // 不发明分组：没有结构时，一个"看起来有含义的划分"比没有更糟。
                ...chronologicalTurns.map((item) =>
                  createElement(
                    'div',
                    { key: `fallback-${item.turn}`, style: { paddingLeft: 8, whiteSpace: 'pre-wrap' } },
                    `#${item.turn}  ${snippet(item.text, 60)}`,
                  ),
                ),
              ),
        )
      : null,

    // ── 详情层 ──────────────────────────────────────────────────────────
    showingDetail
      ? createElement(DetailLayer, {
          node: activeNode,
          turns: activeNodeTurns,
          compactions,
          verdicts,
          latestTurn,
          verdictEdits,
          onVerdictEdit,
          onBack: () => setSelected(undefined),
        })
      : null,

    // **语义判定的状态行。**
    //
    // 三种状态都要说出来。
    //
    // 这里原先还要解释"它跟贴合度不是一回事"——贴合度是**词面**的，
    // 这一条是**跨语言按语义**判的，不说清楚读者会以为两个结论矛盾。
    // 贴合度已随组口径下线（③），现在对照的另一端是**任务结构**：
    // 结构说"这一回合落在哪个任务上"，语义核查说"模型读这一段时认为
    // 哪些回合的落点不清楚"。两者可以同时成立，所以状态行末句写着
    // "这是提示不是判据"。
    // ── 编辑态：顶部固定操作栏（方案 A）──────────────────────────────────
    //
    // 入口**只有一个**且位置固定（好发现），编辑与浏览分离（默认只读，面板干净）。
    // 点回合行 = 选中（可多选）；这里对选中的回合批量操作。
    //
    // **详情层里不出现**（使用者："点进回合详情就不需要保留编辑了，只要展示好回合即可"）。
    // 上一版只清掉了详情层内部的控件，但这条操作栏挂在面板层级、两层都渲染——
    // 所以点进详情后它还在，等于编辑入口没删干净。判据跟别的块一致：`!showingDetail`。
    onOverridesChange === undefined || showingDetail
      ? null
      : createElement(
          'div',
          {
            'data-intent-editbar': editing ? 'on' : 'off',
            style: {
              marginTop: 10, padding: '6px 9px', borderRadius: 6, fontSize: 11,
              border: `1px solid ${editing ? ACCENT : 'color-mix(in srgb, currentColor 18%, transparent)'}`,
              background: editing ? 'color-mix(in srgb, #2e6fd9 8%, transparent)' : 'transparent',
              display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline',
            },
          },
          createElement(
            'button',
            {
              type: 'button',
              'data-intent-edit-toggle': editing ? 'off' : 'on',
              onClick: () => {
                setEditing(!editing)
                setPicked([])
                setPicker(undefined)
              },
              style: {
                cursor: 'pointer', font: 'inherit', borderRadius: 4, padding: '1px 8px',
                border: `1px solid ${editing ? ACCENT : 'color-mix(in srgb, currentColor 30%, transparent)'}`,
                background: editing ? ACCENT : 'transparent',
                color: editing ? '#fff' : 'inherit',
              },
            },
            editing ? '退出编辑' : '编辑落点',
          ),
          editing
            ? createElement(
                'span',
                { style: { color: MUTED }, 'data-intent-drag': dragging.length > 0 ? `turns:${dragging.length}` : draggingNode !== undefined ? `branch:${draggingNode}` : 'none' },
                `已选 ${picked.length} 个回合`,
                // **拖起来的时候要说一句**：拖拽是"看不见状态"的操作，
                // 没有这句就分不清"没拖起来"和"拖起来了但落点没接住"
                dragging.length > 0
                  ? ` · 正在拖 ${dragging.length} 个回合（拖到枝上 = ${draggingFrom === '' ? '挂上去' : '挪过去'}）`
                  : draggingNode !== undefined
                    ? ' · 正在拖一条枝条（拖到别的枝 = 合并，拖到回收站 = 删除）'
                    : '',
              )
            : createElement('span', { style: { color: MUTED } },
                '打开后：点回合行=选中（可多选）；**拖 = 移动**（把这一份挪到目标节点），' +
                  '**「复制到…」= 多挂**（保留原落点再加一个）；枝条也能拖（拖到别的枝条=合并）' +
                  '——**先在树上点选回合**，操作栏的动作才可用'),
          /**
           * **动作始终显示**（编辑态下），没选中时**禁用并说明**——使用者反馈
           * "复制到我没看到单独按钮"：原先按钮只在选中之后才出现 ⇒ 没选中时
           * 界面上根本没有"这里能干什么"的线索。可见性比省地方重要。
           */
          editing
            ? createElement(
                'span',
                {
                  'data-intent-editbar-actions': picked.length,
                  style: { opacity: picked.length === 0 ? 0.45 : 1 },
                },
                picked.length === 0
                  ? createElement('span', { style: { color: MUTED } }, '（先在树上点选回合，再用这些动作）')
                  : null,
                // **选中整枝…**：使用者"枝未选中时可以整棵，之后就是可选"——
                // 点一下把整棵子树的回合铺进选择集；铺开之后每个回合仍能单独取消。
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-editbar-branch': branchPicker ? 'on' : 'off',
                    onClick: () => setBranchPicker((value) => !value),
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '选中整枝…',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-editbar-handoff': picked.length,
                    disabled: picked.length === 0,
                    onClick: () => {
                      setHandoffEdited(undefined)
                      setHandoffNote(undefined)
                      setHandoffOpen(true)
                    },
                    style: {
                      cursor: picked.length === 0 ? 'default' : 'pointer', font: 'inherit',
                      padding: '0 8px 0 0', border: 'none', background: 'transparent',
                      color: 'inherit', textDecoration: 'underline',
                    },
                  },
                  '交接摘要',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-editbar-attach': picked.length,
                    disabled: picked.length === 0,
                    onClick: () => {
                      if (picked.length === 0) return
                      setPicker(picker === 'attach' ? undefined : 'attach')
                    },
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '复制到…（多挂）',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-editbar-clear': picked.length,
                    disabled: picked.length === 0,
                    onClick: () => {
                      // 清掉落点 = 明确"这些回合不挂任何节点"（有效的人工决定，会保留）
                      let next = [...overrides]
                      for (const turn of picked) next = withPlacement(next, turn, [])
                      onOverridesChange(next)
                    },
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '清空落点',
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-new-branch': picked.length,
                    disabled: picked.length === 0,
                    title: '把选中的回合挂到一条**新建的枝**上（只建枝，不凭空建任务节点）',
                    onClick: () => setBranchDraft(branchDraft === undefined ? '' : undefined),
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '新建枝…',
                ),
                branchDraft === undefined
                  ? null
                  : createElement(
                      'span',
                      { 'data-intent-new-branch-input': picked.length },
                      createElement('input', {
                        value: branchDraft,
                        placeholder: '新枝的名字（例如：未归类）',
                        autoFocus: true,
                        onChange: (event: { target: { value: string } }) => setBranchDraft(event.target.value),
                        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                          if (event.key === 'Escape') setBranchDraft(undefined)
                          if (event.key !== 'Enter' || branchDraft.trim() === '') return
                          event.preventDefault()
                          onOverridesChange(
                            newBranchOverrides(overrides, graph, picked, `s${Date.now().toString(36)}`, branchDraft.trim()),
                          )
                          setBranchDraft(undefined)
                          setPicked([])
                        },
                        style: { font: 'inherit', fontSize: 11, padding: '1px 4px', width: 140 },
                      }),
                      createElement(
                        'button',
                        {
                          type: 'button',
                          'data-intent-new-branch-commit': picked.length,
                          onClick: () => {
                            if (branchDraft.trim() === '') return
                            onOverridesChange(
                              newBranchOverrides(overrides, graph, picked, `s${Date.now().toString(36)}`, branchDraft.trim()),
                            )
                            setBranchDraft(undefined)
                            setPicked([])
                          },
                          style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                        },
                        '建好并挂上',
                      ),
                    ),
                // **人工判定不在这条栏里**（使用者 2026-10-10："编辑里面不放人工判定吧"）。
                // 这条栏只做**结构**：移动 / 多挂 / 清空落点 / 还原。
                // 判定是逐回合的标注，入口在**详情层**那一行（读到原文的地方才判得准）。
                createElement(
                  'button',
                  {
                    type: 'button',
                    'data-intent-editbar-restore': picked.length,
                    disabled: picked.length === 0,
                    onClick: () => {
                      // ⚠️ 只还原**落点**。上一版顺手指把选中回合的人工判定也清了——
                      // 一条名为"还原选中"的结构动作不该悄悄改判定（判定在详情层逐条还原）。
                      let nextOverrides = [...overrides]
                      for (const turn of picked) nextOverrides = withoutPlacement(nextOverrides, turn)
                      onOverridesChange(nextOverrides)
                      setPicked([])
                    },
                    title: '撤掉选中回合的人工落点，回到宿主算的那一份',
                    style: { cursor: 'pointer', font: 'inherit', padding: '0 8px 0 0', border: 'none', background: 'transparent', color: 'inherit', textDecoration: 'underline' },
                  },
                  '还原落点',
                ),
              )
            : null,
          // **选择器**：带搜索 + 每个节点显示"收了几个回合 + 前两条预览"——
          // 我上一版只列标题，节点一多根本判断不出该挂哪个（使用者说的"不直观"主因）。
          editing && picker === 'attach' && picked.length > 0
            ? createElement(
                'div',
                { 'data-intent-picker': 'attach', style: { marginTop: 6 } },
                createElement('input', {
                  type: 'text',
                  value: query,
                  placeholder: '搜节点名或回合原文…',
                  'data-intent-picker-search': 'true',
                  onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
                  style: { font: 'inherit', width: '60%', marginBottom: 4 },
                }),
                ...(() => {
                  const rows = Object.entries(graph?.nodes ?? {})
                    .filter(([id]) => id !== 'root')
                    .map(([id, item]) => {
                      const turnsOf = (Object.entries(graph?.membership ?? {}) as [string, string[]][])
                        .filter(([, list]) => list.includes(id))
                        .map(([turn]) => Number(turn))
                        .sort((a, b) => a - b)
                      const preview = turnsOf.slice(0, 2).map((turn) => `「${(turnText.get(turn) ?? '').slice(0, 14)}」`).join(' ')
                      return { id, title: String(item.title ?? id), count: turnsOf.length, preview }
                    })
                    .filter((item) =>
                      query.trim() === '' ||
                      item.title.includes(query.trim()) ||
                      item.preview.includes(query.trim()))
                  if (rows.length === 0) return [createElement('div', { style: { color: MUTED } }, '没有匹配的节点')]
                  return rows.map((item) =>
                    createElement(
                      'button',
                      {
                        key: `pick-${item.id}`,
                        type: 'button',
                        'data-intent-picker-node': item.id,
                        onClick: () => {
                          // **挂到…** = 附加一个落点（多父）；"挪"是拖拽那条路
                          onOverridesChange(attachTurns(overrides, graph, picked, item.id))
                        },
                        style: {
                          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                          border: 'none', background: 'transparent', color: 'inherit',
                          font: 'inherit', fontSize: 11, padding: '2px 0',
                        },
                      },
                      createElement('span', { style: { fontWeight: 600 } }, item.title),
                      createElement('span', { style: { color: MUTED } }, ` · ${item.count} 回合 `),
                      createElement('span', { style: { color: MUTED } }, item.preview),
                    ),
                  )
                })(),
              )
            : null,
        ),

    // ── 编辑态的**回收站**（"拖到空白处"的可靠替代）───────────────────────
    //
    // 原先分两个区（摘除落点 / 删除枝条）。使用者提议合成一个回收站——更符合直觉，
    // 而且**对象类型本来就决定后果**：拖回合进来 = 摘除落点（变独立回合），
    // 拖枝条进来 = 删除。关键是**悬停时把后果写在上面**（两者后果不同，不能让人猜），
    // 并且两种都能撤销（使用者不要常驻清单，这里给单次撤销）。
    // **详情层里也不出现**（与操作栏同一个理由：进了详情就只展示回合）
    onOverridesChange === undefined || !editing || showingDetail
      ? null
      : createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 10.5 } },
          createElement(
            'div',
            {
              'data-intent-dropzone': 'trash',
              onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
              onDrop: (event: { preventDefault: () => void }) => {
                event.preventDefault()
                if (draggingNode !== undefined) {
                  const id = draggingNode
                  onOverridesChange([...overrides, { op: 'delete', id }])
                  setLastRecycled({ kind: 'branch', id, title: String(graph?.nodes[id]?.title ?? id) })
                  setDraggingNode(undefined)
                  return
                }
                if (dragging.length === 0) return
                // 记下它们**原来挂在哪儿**，撤销时才能放回去
                const entries = dragging.map((turn) => ({
                  turn,
                  nodes: placementOf(overrides, turn) ?? (graph?.membership[String(turn)] ?? []),
                }))
                let next = [...overrides]
                for (const turn of dragging) next = withPlacement(next, turn, [])
                onOverridesChange(next)
                setLastRecycled({ kind: 'turns', entries })
                setDragging([])
                setDraggingFrom(undefined)
              },
              style: {
                flex: 1, padding: '6px 8px', borderRadius: 6, textAlign: 'center',
                color: draggingNode !== undefined ? LOW : MUTED,
                border: `1px dashed ${draggingNode !== undefined ? 'color-mix(in srgb, #d9463f 60%, transparent)' : 'color-mix(in srgb, currentColor 30%, transparent)'}`,
                background: draggingNode !== undefined ? 'color-mix(in srgb, #d9463f 6%, transparent)' : 'transparent',
              },
            },
            // **后果写在拖的东西上**：拖什么进来、松开会发生什么，一眼可读
            draggingNode !== undefined
              ? (() => {
                  // **破坏性操作的后果要写出来**：删一枝到底删掉几个枝、几个回合会变独立。
                  // 数字用 `deleteImpact` 现算（与真正执行的那个 op 共用一份实现），
                  // 不在这里估——估出来的数跟实际不一致比不写更糟。
                  const impact =
                    graph === undefined
                      ? { nodes: [] as string[], orphaned: [] as number[] }
                      : deleteImpact(graph, draggingNode)
                  const below = impact.nodes.length - 1
                  return (
                    `松开：删除枝条「${String(graph?.nodes[draggingNode]?.title ?? draggingNode)}」` +
                    (below > 0 ? `及下挂 ${below} 个枝` : '') +
                    (impact.orphaned.length > 0
                      ? `——其中 ${impact.orphaned.length} 个回合变成独立回合`
                      : below > 0
                        ? '——这些枝名下的回合都变成独立回合'
                        : '') +
                    '（可撤销）'
                  )
                })()
              : dragging.length > 0
                ? `松开：摘除这 ${dragging.length} 个回合的落点（它们变成独立回合，可撤销）`
                : '回收站：拖回合进来 = 摘除落点 · 拖枝条进来 = 删除',
          ),
          lastRecycled === undefined
            ? null
            : createElement(
                'button',
                {
                  type: 'button',
                  'data-intent-undo-recycle': lastRecycled.kind === 'branch' ? lastRecycled.id : lastRecycled.entries.length,
                  onClick: () => {
                    if (lastRecycled.kind === 'branch') {
                      // 撤销删除：把那条 delete 覆盖去掉，节点就回来了（原始结构仍在）
                      onOverridesChange(
                        overrides.filter((item) => !(item.op === 'delete' && item.id === lastRecycled.id)),
                      )
                    } else {
                      // 撤销摘除：把原来那些落点**放回去**
                      let next = [...overrides]
                      for (const entry of lastRecycled.entries) next = withPlacement(next, entry.turn, entry.nodes)
                      onOverridesChange(next)
                    }
                    setLastRecycled(undefined)
                  },
                  style: {
                    cursor: 'pointer', font: 'inherit', borderRadius: 4, padding: '0 6px', flex: '0 0 auto',
                    border: `1px solid ${MUTED}`, background: 'transparent', color: 'inherit',
                  },
                },
                lastRecycled.kind === 'branch'
                  ? `撤销删除「${lastRecycled.title}」`
                  : `撤销摘除（${lastRecycled.entries.length} 个回合）`,
              ),
        ),

    // **任务结构**（只读版）：一棵按父子的树 + 分叉点 + 无归属行。
    // 先只读，编辑控件下一步再加（使用者裁定：那两类语义错交给人改，而不是再写判据）。
    !showingDetail
      ? createElement(
          'div',
          {
            'data-intent-structure': structure.kind,
            // 人工覆盖生效了几条、剪掉几个空枝：断言与排查都要能一眼看到
            'data-intent-overrides': overrideCount,
            'data-intent-pruned': prunedCount,
            // 四态各有边框色/淡底（见 `statusLook`）：运行中琥珀、完成蓝、失败红、未开始灰
            style: {
              marginTop: 10,
              padding: '6px 9px',
              borderRadius: 6,
              fontSize: 11.5,
              lineHeight: 1.6,
              ...(({ border, background }) => ({ border, background }))(statusLook(structure.kind)),
            },
          },
          createElement(
            'div',
            { style: { fontWeight: 600, marginBottom: 4 } },
            `${statusLook(structure.kind).glyph} `,
            structure.kind === 'idle'
              ? '任务结构：尚未计算'
              : structure.kind === 'running'
                ? '任务结构：正在算…（多轮调用：建结构 → 分批归属 → 整理 → 根裁定）'
                : structure.kind === 'failed'
                  ? `任务结构：这次没算成（${structure.error ?? ''}）——面板其余部分不受影响`
                  : `任务结构：${Object.keys(structure.structure?.nodes ?? {}).length} 个节点 · ` +
                    `${structure.roots?.projects?.length ?? 0} 条线（${structure.roots?.note ?? ''}）· ` +
                    `${structure.meta?.calls ?? 0} 次调用` +
                    (structure.meta?.adjudication === 'merged' ? ' · 已按裁定归并' : '') +
                    (structure.meta?.reasked ? ` · 补问 ${structure.meta.reasked} 个回合` : '') +
                    (structure.meta?.inherited ? ` · 承接继承 ${structure.meta.inherited} 个` : ''),
          ),
          /**
           * **跳过了哪一段、为什么**（可选段降级）。
           *
           * 使用者实测过"任务结构：这次没算成"有多糟：判整理的回复被截断，整份结构就没了。
           * 现在那一段会降级跳过，但**必须说出来**——否则"少了点的东西"看起来像"本来就这样"。
           */
          (structure.meta?.skipped?.length ?? 0) > 0
            ? createElement(
                'div',
                {
                  'data-intent-skipped': structure.meta?.skipped?.length,
                  title: (structure.meta?.skipped ?? []).join('\n'),
                  style: { color: COMPACT, marginBottom: 4 },
                },
                '⚠ ' + (structure.meta?.skipped ?? []).map((line) => String(line).slice(0, 160)).join('；'),
              )
            : null,
          (singleTurnNodes.size > 0)
            ? createElement(
                'div',
                {
                  'data-intent-fragmentation': singleTurnNodes.size,
                  title: [...singleTurnNodes]
                    .map((id) => `${id} · ${String(graph?.nodes[id]?.title ?? '')}`)
                    .join('\n'),
                  style: { color: MUTED, marginBottom: 4 },
                },
                `碎片：${singleTurnNodes.size} 个枝只收 1 个回合` +
                  '（编辑态用「合并到…」并进相邻枝；自动收拢实测是空操作，所以只提示不动手）',
              )
            : null,
          structure.kind === 'done' && (structure.roots?.forks?.length ?? 0) > 1
            ? createElement(
                'div',
                { 'data-intent-forks': structure.roots?.forks.length, style: { color: MUTED, marginBottom: 4 } },
                '分叉点：' + (structure.roots?.forks ?? []).map((f) => `${f.title} 起于 #${f.at}`).join(' · '),
              )
            : null,
          /**
           * **「没挂任何节点」这一行常显**（不再只在非空时出现）。
           *
           * 使用者报"摘除落点后没有出现无节点回合"——而"这一行没出现"究竟是因为
           * **没有独立回合**，还是因为**那一步根本没生效**，界面上分不出来。
           * 常显之后：写"（无）"就是真的没有；写不出这一行就是面板没渲染到，
           * 两种情况不会再混成一句话。
           */
          structure.kind === 'done'
            ? createElement(
                'div',
                {
                  'data-intent-unattached': tree.unattached.length,
                  style: {
                    marginTop: 6, paddingLeft: 6,
                    borderLeft: '1px dashed color-mix(in srgb, currentColor 30%, transparent)',
                  },
                },
                createElement(
                  'div',
                  { style: { fontSize: 10.5, color: MUTED } },
                  tree.unattached.length === 0
                    ? '没挂任何节点：（无——所有回合都挂在某条枝上）'
                    : `没挂任何节点：${tree.unattached.length} 个回合` +
                      (editing && onOverridesChange !== undefined
                        ? '——**拖到某条枝上即可挂接**，或选中后用「新建枝…」／「复制到…」'
                        : '（开「编辑落点」就能把它们挂回枝上）'),
                ),
                // **渲染成真正的回合行**：与节点里的行同一个渲染器 ⇒ 一样能点选、一样能拖。
                // 这是"独立回合"从"一串号码"变成"能操作的东西"的那一步。
                ...tree.unattached.map((turn) => turnRowElement(nodeRowContext, '', turn, `un-${turn}`)),
              )
            : null,
          /**
           * **诊断块**：把面板看到的这一份状态整段摊出来，供复制。
           *
           * 加它的理由很实际：这一轮"改了没反应"来回了三次，每次我只能靠使用者
           * 手抄一两行。诊断块把**面板实际拿到的东西**（覆盖、结构节点、未归属回合、
           * 被拒原因）一次说全——下一次贴过来就是完整证据，不用再猜。
           */
          overrides.length === 0
            ? null
            : createElement(
                'details',
                { 'data-intent-diag': overrides.length, style: { fontSize: 10.5, color: MUTED, marginTop: 4 } },
                createElement('summary', { style: { cursor: 'pointer' } }, '诊断（改动与结构对照，可复制）'),
                createElement(
                  'textarea',
                  {
                    readOnly: true,
                    style: { width: '100%', height: 120, marginTop: 4, fontFamily: 'monospace', fontSize: 10 },
                    value: [
                      `会话 ${String(sessionId ?? '')}`,
                      `覆盖 ${overrides.length} 条（生效 ${overrideCount} · 被拒 ${rejectedOverrides.length}）`,
                      ...overrides.map((item) =>
                        `${rejectedSet.has(item) ? '✗' : '·'} ${describeOverride(item, titleGraph)}` +
                        (item.op === 'setPlacement' && item.nodes.length > 0
                          ? `（目标存在：${item.nodes.filter((id) => graph?.nodes[id] !== undefined).length}/${item.nodes.length}）`
                          : ''),
                      ),
                      `结构节点 ${Object.keys(graph?.nodes ?? {}).length}：` +
                        Object.entries(graph?.nodes ?? {}).map(([id, node]) => `${id}=${node.title}`).join(' | '),
                      `未归属回合：${tree.unattached.length === 0 ? '（无）' : tree.unattached.join('、')}`,
                      ...rejectedOverrides.map((item) => `被拒：${item.reason}`),
                    ].join('\n'),
                  },
                ),
              ),
          // **改动自己说话**：改过几条（一句话摘要）、被拒几条（原因）、存上了没有。
          // 这三样以前都没显示——"操作没落地"和"落地了但渲染不对"从界面看不出区别。
          createElement(
            'div',
            {
              'data-intent-edit-effect': `${overrideCount}/${rejectedOverrides.length}`,
              style: { fontSize: 10.5, color: rejectedOverrides.length > 0 ? LOW : MUTED, marginTop: 4 },
            },
            /**
             * **只描述生效的那些**（此前把被拒的也算进"改过 N 条"，于是
             * "改过 14 条 · 等 15 条"这种自相矛盾的账——18 条里 4 条没生效）。
             */
            overrideCount === 0
              ? '人工覆盖：没改过'
              : `人工覆盖：改过 ${overrideCount} 条 —— ${describeOverrides(appliedOverrides, titleGraph)}`,
            saveNote === undefined ? '' : ` ⚠ ${saveNote}`,
            remapNote === undefined || remapNote === '' ? '' : ` · ${remapNote}`,
            // 可观测：栈里还有几步（没有这句就不知道 Ctrl+Z 还能不能退）
            undoDepth > 0 ? ` · 可撤销 ${undoDepth} 步（Ctrl+Z）` : '',
          ),
          /**
           * **失效的改动要说全 + 给出路**（使用者 2026-10-10 的读数：
           * `⚠ 另有 4 条没生效：没有这个节点：t22`）。
           *
           * 为什么会有失效的：结构是按会话内容重算的（压缩、整理、合并都会换掉一批 id），
           * 而人工覆盖存的是**当时的 id**。于是"我明明删了这一枝"变成一条指向不存在节点的
           * 覆盖——**静默失败**，看起来就是"点了没反应"。
           *
           * 三条出路都摆在这里：看全部原因、一键清掉失效的、把诊断复制走。
           */
          rejectedOverrides.length === 0
            ? null
            : createElement(
                'div',
                { 'data-intent-rejected-list': rejectedOverrides.length, style: { fontSize: 10.5, color: LOW, marginTop: 2 } },
                `⚠ ${rejectedOverrides.length} 条改动没生效（结构重算后节点 id 变了，这些改动指向的枝条已经不在了）：`,
                ...rejectedOverrides.slice(0, 5).map((item, index) =>
                  createElement('div', { key: `rej-${index}`, style: { paddingLeft: 10 } },
                    `· ${describeOverride(item.override, titleGraph)} —— ${item.reason}`),
                ),
                onOverridesChange === undefined
                  ? null
                  : createElement(
                      'button',
                      {
                        type: 'button',
                        'data-intent-drop-stale': rejectedOverrides.length,
                        onClick: () => {
                          const gone = new Set(rejectedOverrides.map((item) => item.override))
                          onOverridesChange(overrides.filter((item) => !gone.has(item)))
                        },
                        title: '从存下来的改动里去掉这些没生效的（它们指向的节点已经不存在）',
                        style: {
                          cursor: 'pointer', font: 'inherit', fontSize: 10.5, marginTop: 2,
                          border: `1px solid ${LOW}`, borderRadius: 4, background: 'transparent', color: 'inherit',
                        },
                      },
                      '清理失效的改动',
                    ),
              ),
        )
      : null,

    !showingDetail
      ? createElement(
          'div',
          {
            'data-intent-semantic': semantic?.kind ?? 'absent',
            style: {
              marginTop: 10,
              padding: '6px 9px',
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.5,
              color: MUTED,
              ...(({ border, background }) => ({ border, background }))(
                statusLook(semantic === undefined ? 'idle' : semantic.kind === 'done' ? 'done' : semantic.kind),
              ),
            },
          },
          semantic === undefined || semantic.kind === 'idle'
            ? `${statusLook('idle').glyph} 语义核查：尚未判定（需要模型，一次调用判整段会话）`
            : semantic.kind === 'running'
              ? `${statusLook('running').glyph} 语义核查：正在问模型…（逐回合判定，长会话分片依次跑）`
              : semantic.kind === 'failed'
                ? `${statusLook('failed').glyph} 语义核查：这次没判成（${semantic.detail}）——面板其余部分不受影响`
                : (semantic.result.partial ?? 0) > 0
                  // **渐进渲染**：已经出结果了，但还有片在路上——说清楚"这不是最终账"
                  ? `${statusLook('done').glyph} 语义核查：已判 ${semantic.result.verdicts.length} 条，` +
                    `正在补齐（还有 ${semantic.result.partial} 片）——**先看已出的标记**`
                : mismatches === 0
                  ? `${statusLook('done').glyph} 语义核查：模型这次没发现有理解偏离所在节点` +
                    `（${semantic.result.verdicts.length} 条 · ${semantic.result.model}` +
                    // **增量判定的账要露出来**：新判 0 条 = 全部复用上次结论
                    (humanCount > 0 ? `其中 ${humanCount} 条人工判定 · ` : '') +
                    (semantic.result.judged === 0
                      ? ` · 全部复用上次结论`
                      : typeof semantic.result.judged === 'number'
                        ? ` · 新判 ${semantic.result.judged} 条`
                        : '') +
                    '）——**这是提示不是判据**'
                  : `${statusLook('done').glyph} 语义核查：模型读了这一段，认为其中 ${mismatches}/${semantic.result.verdicts.length} ` +
                    `条有问题（理解偏 ${understandingOff} 条 · 越界 ${outOfScope} 条 · ` +
                    // **权限边界（使用者裁定）**：越界只能"建议"，不能直接操作——
                    // 判据只出提示，改不改、挪到哪，由人决定；这里不驱动任何写操作。
                    `${unanimousMismatches} 条全票 · 每批 ${semantic.result.votes ?? 3} 票 · ` +
                    // **第三问单独一段**：它判的是"挂得贴不贴"，不是"agent 做没做错"
                    (farFromParent > 0
                      ? `${farFromParent} 条离父枝较远（顶层枝口径=偏出领域，只是提示） · `
                      : '') +
                    // 第三问**整批缺失**时要说明（否则读者会以为"这一场都很贴"）
                    (missingParent * 2 > verdicts.size
                      ? `⚠ 有 ${missingParent} 条没给出第三问（模型这次没按格式写 parent） · `
                      : '') +
                    `${semantic.result.model}）——**不当位置用**：真配对里本来就有 **57%** 会被标，` +
                    '而随机配对是 93%；这个差距说明它在读内容，但**指不出具体哪一回合**。' +
                    '**越界只能当建议**：要不要挪、挪到哪由你定——系统不会自行改动任何落点',
        )
      : null,

    // 说明只在概况层给：进了详情层，读者已经在看具体内容，不需要这些导读了。
    !showingDetail && model.notes.length > 0
      ? createElement(
          'div',
          {
            style: {
              marginTop: 14,
              paddingTop: 10,
              borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
              fontSize: 10.5,
              color: MUTED,
              lineHeight: 1.6,
            },
          },
          ...model.notes.map((note, index) =>
            createElement('div', { key: index }, `· ${note}`),
          ),
        )
      : null,
  )
}

/**
 * **一片判多少条**（渐进渲染的粒度）。
 *
 * 宿主一次能收 200 条，但"等 200 条"意味着面板要等一整片才算完。切到 12 条：
 * 第一片回来（12 条 × 3 票，命中缓存时 <1 秒）就能出标记，后面的片继续填。
 * **调用总数不变**（宿主内部本来就是 12 条一批 × 3 票），所以成本一分没变。
 */
const PROGRESS_SHARD_TURNS = 12

/**
 * 这份判定是不是**完整的**（不是渐进过程中的半份）。
 *
 * 落盘/入内存缓存的唯一门槛：半份判定一旦被当成最终结论，界面上看不出来。
 */
export function semanticIsComplete(result: { partial?: number } | undefined): boolean {
  return (result?.partial ?? 0) === 0
}

/** tab 主体。 */
export function IntentTab(props: IntentTabProps) {
  const ctx = props.ctx as unknown as ContextLike
  const visible = props.visible !== false
  const scopeSessionId = props.scope?.sessionId ?? undefined
  const data = useIntentData(ctx, scopeSessionId, visible)

  // **基线的键跟着"显示的那个会话"，不是作用域的会话。**
  //
  // 两者只可能在"应用层打开 tab、没有选中会话"时不同（那时是借来的）。
  // 上一版拿的是作用域 id，而显示的是别的会话——**编辑基线会写到别人的键上**。
  const shownSessionId = data?.sessionId ?? scopeSessionId

  // 自定义基线：编辑后立即重算。
  //
  // 会话切换时从 localStorage 读该会话存过的基线。**用 effect 而不是渲染期 setState**
  // ——后者在 React 里是不受支持的更新模式（并发渲染下会丢更新）。
  // 代价是切会话时首帧短暂显示会话目标基线；那比一个偶发的错误状态好。
  /**
   * **人工覆盖**：从浏览器侧读入（插件自己的键命名空间）。
   *
   * 切会话时要立刻换成那个会话的覆盖集，否则会把上一个会话的人工改动套到新会话上
   * ——**那是个不会报错的错**（树看起来还挺合理），所以这里跟着 `shownSessionId` 一起换。
   */
  const [overrides, setOverrides] = useState<TaskOverride[]>([])
  /** 人工修正的判定（盖住模型的两问结论）。 */
  const [verdictEdits, setVerdictEdits] = useState<VerdictOverride[]>([])
  /** **撤销栈**（A4）：最多最近 20 版覆盖列表，Ctrl+Z 逐级回退（内存里，不落盘）。 */
  const [history, setHistory] = useState<TaskOverride[][]>([])
  /** **会话名的人工覆盖**（A3）：结构里没有 root 节点，所以单独存一个字符串。 */
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(undefined)
  /**
   * **旧 id → 旧标题**的索引，用来做 A2 的"按标题接回"。
   *
   * 来源只能是**结构自己**：每次拿到一份可用结构，就把它当时的 id/标题记下来
   * （按会话存）。结构与名字都变了的那种，谁也无从判断——那时不接（留在失效清单）。
   * 内存 + localStorage 各一份：刷新后仍然能接上一次会话留下的旧改动。
   */
  const [titleIndex, setTitleIndex] = useState<Map<string, string>>(new Map())
  const rememberTitles = useCallback(
    (sessionId: string | undefined, nodes: Record<string, { title?: string }> | undefined) => {
      if (sessionId === undefined || nodes === undefined) return
      const key = `dsh-intent-view:titles:v1:${sessionId}`
      let merged = new Map<string, string>()
      try {
        const raw = globalThis.localStorage?.getItem(key)
        if (raw !== null && raw !== undefined) merged = new Map(Object.entries(JSON.parse(raw) as Record<string, string>))
      } catch {
        // 坏数据当没有
      }
      // **只增不改**：一个 id 曾经叫什么，是历史事实；后来重算给出同名新 id 也不该覆盖它
      for (const [id, node] of Object.entries(nodes)) {
        const title = String(node?.title ?? '').trim()
        if (title !== '' && !merged.has(id)) merged.set(id, title)
      }
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(merged)))
      } catch {
        // 存不下只影响下次刷新，不影响本次
      }
      setTitleIndex(merged)
    },
    [],
  )

  useEffect(() => {
    // `loadOverrides` 的存储是**注入**的（`StorageLike`）：宿主、浏览器、测试用同一份逻辑，
    // 各自传自己的 localStorage。这里传浏览器的。
    setOverrides(loadOverrides(globalThis.localStorage, shownSessionId ?? ''))
    setVerdictEdits(loadVerdictOverrides(globalThis.localStorage, shownSessionId ?? ''))
    setSessionTitle(loadSessionTitle(globalThis.localStorage, shownSessionId ?? ''))
  }, [shownSessionId])
  /** 人工判定变了：立即重绘 + 落盘（浏览器侧）。 */
  const applyVerdictEdit = (next: VerdictOverride[]): void => {
    setVerdictEdits(next)
    saveVerdictOverrides(globalThis.localStorage, shownSessionId ?? '', next)
  }
  /** 覆盖变了就落盘（浏览器侧唯一权威）。B4-1 的编辑控件会调它。 */
  /**
   * 覆盖变了就落盘（浏览器侧唯一权威）。
   *
   * **落盘失败必须说出来**（使用者两轮报"改了没反应"）：以前这里丢掉返回值，
   * 于是"没存上"和"存上了"在界面上完全一样，而没存上的后果是刷新/重挂之后改动消失。
   */
  const [saveNote, setSaveNote] = useState<string | undefined>(undefined)
  const applyOverrideList = (next: TaskOverride[]): void => {
    // 压栈（A4 多步撤销）：压的是**改之前**那一版，于是 Ctrl+Z 回到上一步
    setHistory((current) => pushHistory(current, overrides))
    setOverrides(next)
    const saved = saveOverrides(globalThis.localStorage, shownSessionId ?? '', next)
    setSaveNote(saved.ok ? undefined : `这次改动没存上（${saved.error ?? '未知原因'}）——刷新后会丢`)
  }

  /**
   * **Ctrl+Z / Cmd+Z = 撤销上一步**（A4）。
   *
   * 挂在 window 上而不是面板容器上：编辑时焦点常常在树上（`<details>/<summary>`），
   * 容器不一定拿到键盘事件。只在面板可见时响应，免得和别处的撤销打架。
   */
  useEffect(() => {
    if (!visible) return undefined
    const onKey = (event: { key?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; preventDefault?: () => void; target?: { tagName?: string } }): void => {
      const isUndo = (event.ctrlKey === true || event.metaKey === true) && String(event.key ?? '').toLowerCase() === 'z' && event.shiftKey !== true
      if (!isUndo) return
      // 正在输入框里打字时不抢（浏览器/输入框自己的撤销更合适）
      const tag = String(event.target?.tagName ?? '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      setHistory((current) => {
        const stepped = popHistory(current)
        if (stepped.list === undefined) return current
        event.preventDefault?.()
        setOverrides(stepped.list)
        saveOverrides(globalThis.localStorage, shownSessionId ?? '', stepped.list)
        return stepped.stack
      })
    }
    globalThis.addEventListener?.('keydown', onKey as never)
    return () => globalThis.removeEventListener?.('keydown', onKey as never)
  }, [visible, shownSessionId])

  const projection = data?.projection as ProjectionLike | undefined
  // 语义判定：面板可见、且内容指纹与已判定的不一致时才请求（C）。
  const contentHash = String(
    (projection as { intent?: { contentHash?: string } } | undefined)?.intent?.contentHash ?? '',
  )
  // **压缩回合随投影来。** 宿主 fold 从 `compaction/start` 事件收集它们，
  // 客户端不需要读任何文件——这里曾经有一整块读文件的死逻辑，见 `compaction.ts`。
  const compactions = (projection as { intent?: IntentCompaction } | undefined)?.intent
  // **模型要先算**：结构请求的材料（逐回合原文）取自已算好的渲染模型。
  // 顺序写反过一次（hook 在 `model` 之前用了它），tsc 当场拦下——这正是
  // 「判据要可观测」的好例子：编译器盯着的错误不会溜到运行时。
  const model =
    data === undefined
      ? undefined
      : modelFromProjection(projection, data.title)
  // ── 任务结构 → 语义核查：**顺序不能反** ──────────────────────────────
  //
  // 语义核查的判据容器现在是**任务节点**（弃组之后），材料 = 结构里的节点 + 它名下的回合。
  // 所以必须先算出结构，才能组材料。写反过一次（hook 用到了还没声明的 structure），
  // tsc 当场拦下——和上一版"hook 在 model 之前用它"是同一类错。
  const structureTurnsList = structureTurns(model)
  const structure = useStructure(shownSessionId, contentHash, structureTurnsList, visible)
  // 结构变了就把"这一刻的 id → 标题"记下来（A2 靠它把旧改动接回新 id）。
  // ⚠️ 必须放在 `structure` 声明**之后**：写在前面 tsc 会报"used before its declaration"。
  useEffect(() => {
    rememberTitles(shownSessionId, structure.structure?.nodes)
  }, [shownSessionId, structure, rememberTitles])
  /**
   * **生效结构 = 剪枝(叠加覆盖(宿主原始结构))**——面板与判定材料共用这一份。
   *
   * 以前判定材料用的是宿主原始结构，于是"人工把落点改对了、标记却还按旧结构算"，
   * 两处不一致且不报错。现在只有这一个入口（`effectiveStructure` 里顺序也是有意的：
   * 先叠覆盖再剪枝，否则刚建的空枝会在挂回合之前被剪掉）。
   */
  /**
   * **A2：把指向已消失节点的落点按标题接回当前结构**（读取时修复）。
   *
   * 只重接 `setPlacement`、且旧标题到新节点**唯一**才接（规则在
   * `remapOverridesByTitle` 里，纯函数、有断言）。接不了的仍是"失效"，
   * 面板会照旧列出并允许一键清理；`DSH_INTENT_REMAP_BY_TITLE=0` 可整体关掉。
   */
  const remapped = remapEnabled()
    ? remapOverridesByTitle(overrides, titleIndex, structure.structure?.nodes ?? {})
    : { list: [...overrides], remapped: [] as { from: string; to: string; title: string }[] }
  const effectiveOverrides = remapped.list
  const remapNote = remapReceipt(remapped.remapped)
  const effective = effectiveStructure(structure.structure ?? { nodes: {}, membership: {} }, effectiveOverrides)
  const tree = structureOutline(structure.structure === undefined ? undefined : effective.graph, structureTurnsList)

  const statements = new Map<number, string>()
  const turnTextForSemantic = new Map<number, string>()
  /**
   * **agent 实际做了什么**：官方 `turnOutline.response`——客户端本来就有（回退列表也在用它）。
   *
   * 判据要判的是"agent 有没有按用户交办的任务做事"，所以"做了什么"是必须的那一列；
   * 只有用户指令 + agent 自述理解时，**"理解对了、做错了"这一类看不见**。
   */
  const didForSemantic = new Map<number, string>()
  // `model` 未就绪时这里要能空过——**hook 不能条件调用**，所以不能靠提前 return 兜
  for (const turn of model?.turns ?? []) {
    if (turn.statement !== undefined && turn.statement !== '') statements.set(turn.turn, turn.statement)
    if (turn.prompt !== '') turnTextForSemantic.set(turn.turn, turn.prompt)
    if (turn.response !== '') didForSemantic.set(turn.turn, turn.response)
  }
  // **压缩过的回合也要判**（使用者 2026-10-10 裁定）：历史被截断之后最容易做偏，
  // 而 `compactionTurns` 是宿主 fold 从事件流收的真值（wire 上一直有）。
  const semanticMaterialValue = semanticMaterial(
    structure.structure === undefined ? undefined : effective.graph,
    turnTextForSemantic,
    statements,
    compactions?.compactionTurns ?? [],
    didForSemantic,
  )
  const semantic = useSemantic(
    shownSessionId,
    semanticKey(semanticMaterialValue),
    semanticMaterialValue,
    visible && structure.kind === 'done',
  )

  if (model === undefined) {
    return createElement(
      'div',
      { style: { ...SCROLL, padding: 16, fontSize: 12, color: MUTED } },
      '等待会话数据…',
    )
  }
  // **转向点从投影读，不再在浏览器里算。**
  //
  // 计算已搬到宿主（`src/host/intentProjection.ts` 的 `wire.view`），
  // 浏览器只渲染——这是 DSH 的 capability-seam。

  return createElement(IntentBody, {
    model,
    // **宽区档必须真的传下去**（这一行曾经漏了）：`makeConversationView` 传 `wide: true`，
    // 而主体没往下传 ⇒ 主区仍按窄列排（改动看着生效、其实没生效）。断言盯着这条。
    wide: props.wide === true,
      compactions,
    sessionId: shownSessionId,
    semantic,
    structure,
    tree,
    graph: effective.graph,
    overrideCount: effective.applied,
    prunedCount: effective.pruned.length,
    rejectedOverrides: effective.rejected,
    saveNote,
    remapNote,
    undoDepth: history.length,
    sessionTitle,
    onSessionTitleChange: (next: string) => {
      setSessionTitle(next.trim() === '' ? undefined : next.trim())
      saveSessionTitle(globalThis.localStorage, shownSessionId ?? '', next)
    },
    overrides,
    onOverridesChange: applyOverrideList,
    verdictEdits,
    onVerdictEdit: applyVerdictEdit,
    borrowed: data?.borrowed === true,
  })
}

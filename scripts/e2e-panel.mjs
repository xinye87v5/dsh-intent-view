#!/usr/bin/env node
/**
 * 端到端验证：插件在 DSH 里**真的加载了**（真浏览器）。
 *
 * 要求两件事同时成立：
 *   1. `dsh-intent-view` 出现在模块加载缓存里——**注册真的发生了**；
 *   2. **零 console / page 错误**——注册成功不代表运行时没问题。
 *
 * ## 为什么不用 playwright
 *
 * Python 版用的是 `playwright`。移植时本可以装 Node 版 playwright，但那会给
 * 一个**构建期可选**的检查引入一份重依赖（还会拉一份浏览器）。
 *
 * 而这里需要的能力很小：开一个浏览器、求值一段 JS、收 console 事件。
 * **Chrome DevTools Protocol 直连就够了**——Node 22 自带 `WebSocket`，
 * 所以整个检查零依赖。
 *
 * ## 一个必须记住的细节
 *
 * 模块注册发生在 `domcontentloaded` **之前**，所以**挂不上钩子去"抓"它**，
 * 只能等一段时间再读缓存（Python 版等 22 秒，这里同）。
 *
 * ## 这个检查**不覆盖**什么（写清楚，免得它被当成万能证明）
 *
 * 它不检查**渲染出的界面**。渲染由离线检查覆盖（`verify-intent-tab`，65 条断言
 * 直接对 `renderToStaticMarkup` 的结果断言），**活数据**由下面这段探针覆盖
 * （宿主折叠出的 `intent` 真的到了浏览器）。两者接上，链路就是完整的。
 *
 * 想在真浏览器里驱动界面的话，有三道坎（都实测撞过，别重走）：
 *   1. `betterSidebar.openTab(seed)` 在**没有当前会话**时直接 return；而且就算
 *      有，它只把 tab 写进 state，**不会展开面板**——折叠状态下 tab 卡片是
 *      hidden，`element is not visible`。要先点 `[aria-label="Expand sidebar"]`；
 *   2. 面板显示的是**当前会话**，要验哪个会话就得真的在侧栏切过去
 *      （排在树里看不见的用 "Search sessions" 搜）；
 *   3. 别拿 `sessions.list` 快照的 `sessionId` 判断"有没有选中会话"——那是会话
 *      管理器，没这个字段，永远 undefined。要用 `bar.getSnapshot().sessionId`。
 *
 * 用法：`node scripts/e2e-panel.mjs <url>`
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/** 等页面稳定多久再读模块缓存。见文件头：注册早于 domcontentloaded，只能等。 */
export const SETTLE_MS = 22_000

export function findChromium() {
  const root = path.join(os.homedir(), '.cache', 'ms-playwright')
  if (!existsSync(root)) return undefined
  const versions = [
    ...new Set(
      readdirSync(root)
        .filter((name) => name.startsWith('chromium-'))
        .sort()
        .reverse(),
    ),
  ]
  for (const version of versions) {
    const candidate = path.join(root, version, 'chrome-linux64', 'chrome')
    if (existsSync(candidate)) return candidate
    const alt = path.join(root, version, 'chrome-linux', 'chrome')
    if (existsSync(alt)) return alt
  }
  return undefined
}

/**
 * 共享库目录。
 *
 * 这台机器缺 8 个库（`libatk` / `libatspi` / `libasound` / `libXcomposite` /
 * `libXdamage` / `libXfixes` / `libXrandr` / `libatk-bridge`），Chromium 起不来。
 * （`--disable-dev-shm-usage` 解决的是另一个问题：`/dev/shm` 无权限导致的 core
 * dump——那时看起来像"库不兼容"，其实是权限。）
 *
 * ## 为什么这里要去找库，而不是假定 `/tmp/chlibs` 已经准备好
 *
 * 原来这里只返回 `/tmp/chlibs`，指望它已经被人工填好。**`/tmp` 会被清掉**，
 * 清掉之后 Chromium 报的是 `error while loading shared libraries:
 * libatk-1.0.so.0` —— 一个看起来像"浏览器装坏了"的错误，而实际原因是
 * **这个脚本自己的前提没了**。我为此白查了一轮。
 *
 * 所以：自己找一份能用的，找不到就**把话说明白**（缺哪几个库、去哪儿找），
 * 而不是启动一个注定失败的浏览器。
 */
export function libDir() {
  const dir = '/tmp/chlibs'
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const chromium = findChromium()
  if (chromium === undefined) return dir
  const missing = missingLibs(chromium)
  if (missing.length === 0) return dir

  // 候选来源：本机上确实带这些库的地方（flatpak 的 KDE 运行时最全）。
  const flatpakRoot = path.join(os.homedir(), '.local', 'share', 'flatpak', 'runtime')
  const candidates = []
  if (existsSync(flatpakRoot)) {
    for (const runtime of readdirSync(flatpakRoot)) {
      const base = path.join(flatpakRoot, runtime, 'x86_64')
      if (!existsSync(base)) continue
      for (const version of readdirSync(base)) {
        for (const commit of readdirSync(path.join(base, version))) {
          candidates.push(
            path.join(base, version, commit, 'files', 'lib', 'x86_64-linux-gnu'),
          )
        }
      }
    }
  }
  const linked = new Set()
  for (const lib of missing) {
    for (const source of candidates) {
      const candidate = path.join(source, lib)
      if (!existsSync(candidate)) continue
      try {
        symlinkSync(candidate, path.join(dir, lib))
      } catch {
        // 已经软链过就算了
      }
      linked.add(lib)
      break
    }
  }
  // **只报"我补不上的"**。补完之后 `ldd` 往往还会列出一些**传递依赖**——
  // 那些是这个库自己的依赖，不影响 Chromium 起不来。上一版把它们也算作
  // "缺库"并打了红字，于是**一次成功的运行里也出现了失败字样**。
  const unfixed = missingLibs(chromium).filter((lib) => !linked.has(lib))
  if (unfixed.length > 0) {
    console.error(
      `⚠ Chromium 可能还缺库（本机找不到）：${unfixed.join(', ')}\n` +
        `  找过这些目录：${candidates.slice(0, 3).join(', ') || '(没有 flatpak 运行时)'}\n` +
        '  这是环境问题，不是插件问题——但如果下面的检查跑通了，就说明够用了。',
    )
  }
  return dir
}

/** 用 `ldd` 问出 Chromium 缺哪些库。 */
export function missingLibs(chromium) {
  try {
    const out = execFileSync('ldd', [chromium], { encoding: 'utf8' })
    return out
      .split('\n')
      .filter((line) => line.includes('not found'))
      .map((line) => line.trim().split(/\s+/)[0])
  } catch {
    return []
  }
}

/** 一个最小 CDP 客户端：够用即可，不做通用化。 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  on(listener) {
    this.listeners.push(listener)
  }

  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 求值一段 JS 表达式并返回它的值（支持 Promise）。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '求值抛异常')
    }
    return result.result.value
  }
}

export async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`CDP 端点 ${port} 在 ${timeoutMs}ms 内没出现`)
}

export async function main(argv) {
  const url = argv[0]
  if (!url) {
    console.error('用法: node scripts/e2e-panel.mjs <url>')
    return 2
  }

  const chromium = findChromium()
  if (chromium === undefined) {
    console.error('✗ 找不到 chromium——检查 ~/.cache/ms-playwright')
    return 2
  }
  const libs = libDir()

  const port = 9333 + Math.floor(Math.random() * 500)
  const browser = spawn(
    chromium,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage', // `/dev/shm` 无权限会 core dump，看起来像库不兼容
      '--disable-gpu',
      // **窗口要大**：默认 800×600 会落进应用的窄屏模式，侧栏整棵会话树不渲染，
      // 于是"点一个会话去触达投影单元格"这一步永远找不到元素。
      '--window-size=1600,1000',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=/tmp/dsh-e2e-${process.pid}`,
      'about:blank',
    ],
    { env: { ...process.env, LD_LIBRARY_PATH: libs }, stdio: 'ignore' },
  )

  const errors = []
  let state = {}
  let code = 1
  try {
    const wsUrl = await waitForEndpoint(port, 20_000)
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    cdp.on((message) => {
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = message.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 200)
        errors.push(`console.error: ${text}`)
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const text = message.params.exceptionDetails?.exception?.description ?? ''
        errors.push(`pageerror: ${text.slice(0, 200)}`)
      }
    })

    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url })
    // 注册早于 domcontentloaded，只能等。见文件头。
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    state = await cdp.evaluate(`(() => {
      const ms = window.__dshSidebarModuleSystem__;
      if (!ms) return { ok: false, reason: '模块系统未出现' };
      const ids = [...ms.loadCache.keys()];
      return {
        ok: true,
        count: ids.length,
        hasMine: ids.includes('dsh-intent-view'),
        hasBetterSidebar: ids.includes('dsh-better-sidebar'),
      };
    })()`)

    // **先触达一个会话**：投影单元格是**懒建**的（官方契约：`Cells build lazily —
    // a unit registered after events flowed, or a session older than the registry,
    // folds init over the in-memory log on first touch`）。
    //
    // 所以 `stateVersion` 一跳、缓存行全部作废之后，**在应用层读列表快照会是全空**，
    // 直到某个会话被打开。我为此误判过两次：一次以为"加必填字段把 restore 弄坏了"，
    // 一次以为"冷重折太慢"——两次都不是。真正发生的是**缓存作废 + 单元格还没建**。
    //
    // 点一下树里的会话就是"触达"。点不到不算失败（DOM 会变），但要把话说出来。
    // **会话树也是慢慢出来的**：22 秒时模块系统在了，但树还没渲染——
    // 第一版在这里点了个空（"没有可点的会话行"）。所以要点到为止地等。
    let touched = '还没试'
    const touchDeadline = Date.now() + 25_000
    while (Date.now() < touchDeadline) {
      // **要穿透 shadow root 找**：会话树不在顶层文档里，
      // `document.querySelectorAll('[role=treeitem]')` 一直是空的。
      // （playwright 的定位器默认会穿 shadow DOM，所以那边的脚本能找到——
      //  这也是"换了个工具就找不到元素"的原因。）
      touched = await cdp.evaluate(`(() => {
        const deep = (selector) => {
          const out = [];
          const walk = (root) => {
            for (const el of root.querySelectorAll(selector)) out.push(el);
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out;
        };
        const rows = deep('[role=treeitem]');
        const row = rows[2] ?? rows[1];
        if (row === undefined) return '没有可点的会话行';
        row.click();
        return 'ok';
      })()`)
      if (touched === 'ok') break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (touched !== 'ok') console.log(`触达会话: ${touched}——数据检查可能因"单元格未建"而空`)
    await new Promise((resolve) => setTimeout(resolve, 8000))

    // 数据通路：**宿主折叠算出来的 `intent` 真的到了浏览器**。
    //
    // 注册成功只说明 tab 挂上了；投影键没到的话面板是个空壳，而那是
    // 这个项目栽过两次的地方（缺 `inject` / 漏加 `stateVersion`）。
    //
    // **要轮询，不能只采一次**：列表快照里的投影值随会话被观察到而**陆续**
    // 出现，固定时刻采一次会假报"链路通但没有数据"——这条我实测撞到过
    // （22 秒采为 null，24 秒就有值）。一个因时序而假报的检查等于没有检查。
    const DEADLINE_MS = 30_000
    let probe
    const startedAt = Date.now()
    for (;;) {
      probe = await cdp.evaluate(
        `(() => {
          const d = window.__intentViewDiagnostics;
          if (!d) return { ok: false, reason: '诊断钩子未挂上（非回环地址？）' };
          return { ok: true, ...d.intentProbe() };
        })()`,
      )
      const sample = probe?.sample0
      const ready = probe?.ok && (probe.keys ?? []).includes('intent') && sample?.turnCount > 0
      if (ready || Date.now() - startedAt > DEADLINE_MS) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const waitedMs = Date.now() - startedAt
    ws.close()

    console.log(`页面: ${url.split('?')[0]}`)
    console.log(`模块系统: ${JSON.stringify(state)}`)
    console.log(`错误数: ${errors.length}`)
    for (const error of errors.slice(0, 8)) console.log(`  ${error}`)

    const keys = probe?.keys ?? []
    const sample = probe?.sample0
    console.log(`投影键: ${JSON.stringify(keys)}`)
    console.log(`投影样本（等 ${(waitedMs / 1000).toFixed(0)}s）: ${JSON.stringify(sample ?? null)}`)
    // 有则报，无则显式说"本机没有这样的会话"——**不假装验过**。
    console.log(
      probe?.goalSample
        ? `目标时间线样本: ${JSON.stringify(probe.goalSample.id)} ${JSON.stringify(probe.goalSample.goalTimeline)} onset=${probe.goalSample.goalOnset}`
        : '目标时间线样本: 本机没有带 goal 事件的会话，这条通路**本次未验**',
    )
    console.log(
      probe?.compactionSample
        ? `压缩样本: ${JSON.stringify(probe.compactionSample.id)} turns=${JSON.stringify(probe.compactionSample.compactionTurns)}`
        : '压缩样本: 本机没有压缩过的会话，这条通路**本次未验**',
    )

    const reasons = []
    if (!state?.hasMine) reasons.push('插件没出现在模块加载缓存里')
    if (errors.length > 0) reasons.push(`${errors.length} 个 console/page 错误`)
    if (!probe?.ok) reasons.push(`诊断钩子不可用: ${probe?.reason ?? '未知'}`)
    else if (!keys.includes('intent')) reasons.push('投影键里没有 intent——宿主单元没生效')
    else if (!(sample?.turnCount > 0)) reasons.push('投影样本是空的——链路通但没有数据')

    console.log()
    if (reasons.length === 0) console.log('✓ 通过')
    else for (const reason of reasons) console.log(`✗ ${reason}`)
    code = reasons.length === 0 ? 0 : 1
  } catch (error) {
    console.error(`✗ ${error.message}`)
    code = 2
  } finally {
    browser.kill('SIGKILL')
  }
  return code
}

// 只在**直接运行**时走 CLI；被别的探针 import 时不该执行原来的检查
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))

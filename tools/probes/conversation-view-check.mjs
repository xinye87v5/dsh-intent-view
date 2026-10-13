#!/usr/bin/env node
/**
 * **主区对话视图能否点开**（步骤③）：先点会话行，再看 tab 条。
 *
 * 上一轮我漏了"先点会话行"这一步 ⇒ 对话区是空态、`[role=tab]` 为空，
 * 那次报的 `tabs: []` 是**检查方式不成立**，不是阴性结论。这里把顺序写死。
 *
 * 三种结果对应三种处置（见 goal 步骤③）：
 * - 有「意图」tab 且点开渲染出面板 ⇒ 补活体点击探针 + 更新 README 那条限制；
 * - 有 tab 但点不开 ⇒ 记现象与 DOM 证据，保留限制；
 * - 根本没有 tab ⇒ register 的参数或 inject 声明还差东西，回查契约。
 *
 * 用法：`node tools/probes/conversation-view-check.mjs <url>`
 */
import { spawn } from 'node:child_process'
import { Cdp, SETTLE_MS, findChromium, libDir, waitForEndpoint } from '../../scripts/e2e-panel.mjs'

const url = process.argv[2]
if (!url) {
  console.error('用法: node tools/probes/conversation-view-check.mjs <url>')
  process.exit(2)
}
const port = 14500 + Math.floor(Math.random() * 400)
const browser = spawn(
  findChromium(),
  [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--window-size=1600,1000', `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/dsh-cv2-${process.pid}`, 'about:blank',
  ],
  { env: { ...process.env, LD_LIBRARY_PATH: libDir() }, stdio: 'ignore' },
)

const HELPERS = `
  const deep = (selector) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  };
  const text = (el) => (el.innerText || el.textContent || '').trim();
  const panel = () => deep('[data-intent-structure]').length > 0;
`

let code = 1
try {
  const ws = new WebSocket(await waitForEndpoint(port, 25_000))
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  // ① **必须先选一个会话**——否则对话区是空态，连 Chat/Trajectory 都没有
  const picked = await cdp.evaluate(`(() => {
    ${HELPERS}
    const rows = deep('[role=treeitem]');
    const row = rows[2] ?? rows[1];
    if (row) row.click();
    return { rows: rows.length, picked: row ? text(row).slice(0, 20) : null };
  })()`)
  console.log('① 选会话:', JSON.stringify(picked))
  await new Promise((r) => setTimeout(r, 9000))

  // ② 主区 tab 条 + 诊断
  const after = await cdp.evaluate(`(() => {
    ${HELPERS}
    const d = window.__intentViewDiagnostics;
    return {
      registered: d ? d.conversationView : 'no-hook',
      tabs: deep('[role=tab]').map(text).slice(0, 12),
      panel: panel(),
    };
  })()`)
  console.log('② tab 条:', JSON.stringify(after))

  // ③ 有「意图」就点它
  const clicked = await cdp.evaluate(`(() => {
    ${HELPERS}
    const hit = deep('[role=tab]').find((el) => text(el).includes('意图'));
    if (!hit) return { clicked: false };
    hit.click();
    return { clicked: true };
  })()`)
  console.log('③ 点「意图」:', JSON.stringify(clicked))
  await new Promise((r) => setTimeout(r, 6000))

  const final = await cdp.evaluate(`(() => {
    ${HELPERS}
    return {
      panel: panel(),
      outline: deep('[data-intent-outline]').length > 0,
      editbar: deep('[data-intent-editbar]').length > 0,
      // **宽区档有没有真的生效**：主区比窄列宽得多，版式该是"限宽 1100 居中"。
      // 读的是渲染结果的祖先链（不是源码里的常量）。
      wideLimit: (() => {
        let el = deep('[data-intent-structure]')[0] || null;
        while (el) {
          const mw = getComputedStyle(el).maxWidth;
          if (mw && mw !== 'none') return mw;
          el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
        }
        return null;
      })(),
      // **碎片读数**：只收 1 个回合的叶子枝有几个（口径见 IntentTab.ts）
      frag: (() => {
        const el = deep('[data-intent-fragmentation]')[0];
        return el ? el.getAttribute('data-intent-fragmentation') : 'none';
      })(),
      tabs: deep('[role=tab]').map(text).slice(0, 12),
    };
  })()`)
  console.log('④ 末态:', JSON.stringify(final))
  console.log(final.wideLimit === '1100px'
    ? '   ↳ 宽区版式生效（祖先链上 max-width:1100px）'
    : `   ↳ ⚠ 没读到宽区限宽（读到 ${final.wideLimit}）——主区可能还在按窄列排`)

  if (final.panel) {
    console.log('\n✓ 主区视图渲染出来了（面板 DOM 在）——这条路的活体验证走通')
    code = 0
  } else if (after.tabs.some((t) => t.includes('意图'))) {
    console.log('\n⚠ 有「意图」tab 但点开后没渲染出面板：记现象，保留 README 那条限制')
  } else {
    console.log('\n✗ tab 条上没有「意图」：register 的参数或 inject 声明还差东西')
  }
  ws.close()
} catch (error) {
  console.error('✗ ' + error.message)
  code = 2
} finally {
  browser.kill('SIGKILL')
}
process.exit(code)

#!/usr/bin/env node
/**
 * **真浏览器里的存储往返检查**（不需要打开意图 tab）。
 *
 * ## 为什么有这个探针
 *
 * "改一条 → 刷新 → 还在不在"这条链里，只有 `localStorage` 那一段**真浏览器**能验：
 * 键名对不对、序列化对不对、写失败会不会静默。而点面板需要 CDP 把意图 tab 打开，
 * 那件事试过两条路（`betterSidebar.openTab(id)` 与右侧栏 `+` 引导页）都没成。
 *
 * 于是换个入口：插件在 localhost 上挂了诊断钩子，其中 `overrideRoundTrip()` 走的是
 * **面板同一条代码路径**（`saveOverrides` / `loadOverrides`）。探针只要:
 *   ① 调它写一遍读一遍 —— 验证键名/序列化/浏览器真实行为;
 *   ② **重新加载页面**再读一次 —— 这才是"刷新后还在不在"。
 *
 * ## 启动参数必须与 `e2e-panel.mjs` 一致
 *
 * 少一个 `--disable-dev-shm-usage` 就会 core dump，而现象是"CDP 端点没出现"，
 * 看起来像库不兼容（e2e-panel 的注释里写着这条，我漏抄过一次，白跑两轮）。
 *
 * 用法：`node tools/probes/panel-storage-check.mjs <url>`
 */
import { spawn } from 'node:child_process'
import { Cdp, SETTLE_MS, findChromium, libDir, waitForEndpoint } from '../../scripts/e2e-panel.mjs'

const url = process.argv[2]
if (!url) {
  console.error('用法: node tools/probes/panel-storage-check.mjs <url>')
  process.exit(2)
}
const chromium = findChromium()
if (chromium === undefined) {
  console.error('✗ 找不到 chromium（~/.cache/ms-playwright）')
  process.exit(2)
}

const port = 12000 + Math.floor(Math.random() * 900)
const browser = spawn(
  chromium,
  [
    '--headless=new',
    '--no-sandbox',
    // ⚠️ 这一行必须有：`/dev/shm` 无权限会 core dump，现象是"CDP 端点没出现"
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1600,1000',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/dsh-storage-${process.pid}`,
    'about:blank',
  ],
  { env: { ...process.env, LD_LIBRARY_PATH: libDir() }, stdio: 'ignore' },
)

let code = 1
try {
  const ws = new WebSocket(await waitForEndpoint(port, 25_000))
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  const write = await cdp.evaluate(`(() => {
    const d = window.__intentViewDiagnostics;
    if (!d || typeof d.overrideRoundTrip !== 'function') return { ok: false, reason: '诊断钩子没有 overrideRoundTrip' };
    const one = d.overrideRoundTrip('probe-roundtrip', [
      { op: 'setPlacement', turn: 7, nodes: [] },
      { op: 'delete', id: 'n9' },
    ]);
    d.overrideRoundTrip('probe-other', [{ op: 'rename', id: 'n1', title: '甲' }]);
    // 不传载荷 = **只读**（不写），用它确认刚才那次写真的落进去了
    const two = d.overrideRoundTrip('probe-roundtrip');
    return { ok: true, saved: one.saved, wrote: one.wrote, read: one.read, same: one.same,
      readBackSame: JSON.stringify(two.read) === JSON.stringify(one.wrote),
      keys: Object.keys(localStorage).filter((k) => k.includes('intent-view')).sort() };
  })()`)
  console.log('① 写一遍读一遍：', JSON.stringify(write))

  // ② **重新加载**（这才是"刷新后还在不在"），再读一次
  await cdp.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  const after = await cdp.evaluate(`(() => {
    const d = window.__intentViewDiagnostics;
    if (!d || typeof d.overrideRoundTrip !== 'function') return { ok: false, reason: '刷新后钩子不在' };
    // 不传载荷 ⇒ 只读（第一版这里传了载荷，等于又写了一遍，验不出"刷新后还在"）
    // **只读**：这才是"刷新后还在不在"
    const read = d.overrideRoundTrip('probe-roundtrip');
    return { ok: true, read: read.read, same: read.same };
  })()`)
  console.log('② 刷新之后再读：', JSON.stringify(after))

  const passed =
    write.ok === true && write.same === true && write.readBackSame === true &&
    (write.keys ?? []).length === 2 &&
    after.ok === true && JSON.stringify(after.read) === JSON.stringify(write.wrote)
  console.log(passed ? '\n✓ 通过：面板写的键，刷新后读回来的还是它' : '\n✗ 不通过：见上面的读数')
  code = passed ? 0 : 1
  ws.close()
} catch (error) {
  console.error('✗ ' + error.message)
  code = 2
} finally {
  browser.kill('SIGKILL')
}
process.exit(code)

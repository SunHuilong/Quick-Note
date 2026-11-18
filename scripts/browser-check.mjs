import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBrowserHost, exampleTasks } from '../tests/browser-host.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'dist')
const artifacts = resolve(root, 'artifacts')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
const results = []
const runtimeErrors = []
let browser
let socket
let server
let profile
let id = 0
const pending = new Map()

function send(method, params = {}, sessionId) {
  return new Promise((done, fail) => {
    const requestId = ++id
    const timeout = setTimeout(() => { pending.delete(requestId); fail(new Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(requestId, { done, fail, timeout })
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function until(page, expression, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(page, expression)) return
    await sleep(50)
  }
  throw new Error(`Condition failed: ${expression}`)
}
async function check(name, run) {
  await run()
  results.push(name)
  console.log(`PASS ${name}`)
}
async function fill(page, selector, value) {
  await evaluate(page, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', { bubbles: true })); })()`)
}
async function click(page, selector) {
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).click()`)
  await sleep(70)
}
async function press(page, selector, key) {
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`)
  await sleep(70)
}
async function pointerClick(page, selector) {
  await send('Page.bringToFront', {}, page)
  const point = await evaluate(page, `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, page)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, page)
  await sleep(70)
}
async function screenshot(page, name) {
  await send('Page.bringToFront', {}, page)
  await sleep(100)
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, page)
  await writeFile(join(artifacts, `${name}.png`), Buffer.from(data, 'base64'))
}
const row = id => `[data-task-id="quick-note/task/${id}"]`
const collapseButton = 'button[aria-controls="timeline-board"]'

try {
  await access(join(dist, 'index.html'))
  await mkdir(artifacts, { recursive: true })
  // 每次自检使用独立配置目录和 OS 分配的空闲端口，结束时关闭所有测试进程。
  profile = await mkdtemp(join(tmpdir(), 'quick-note-check-'))
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(dist + sep)) { response.writeHead(403).end(); return }
    try {
      const data = await readFile(file)
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(data)
    } catch { response.writeHead(404).end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]
  let executable
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break } catch {} }
  if (!executable) throw new Error('浏览器自检需要已安装的 Chrome 或 Edge。')
  browser = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--disable-component-update', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  let portFile
  for (let attempt = 0; attempt < 100; attempt++) {
    try { portFile = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); break } catch { await sleep(100) }
  }
  if (!portFile) throw new Error('测试浏览器未启动调试端口。')
  const [port, socketPath] = portFile.trim().split(/\r?\n/)
  socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`)
  await once(socket, 'open')
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timeout)
      pending.delete(message.id)
      if (message.error) request.fail(new Error(JSON.stringify(message.error)))
      else request.done(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') runtimeErrors.push(message.params.args)
  })
  async function page(sticky, width, height, mock = true) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Runtime.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
    if (mock) await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installBrowserHost.toString()})(${JSON.stringify(exampleTasks())})` }, sessionId)
    await send('Page.navigate', { url: `${origin}/index.html${sticky ? '?view=sticky' : ''}` }, sessionId)
    await until(sessionId, mock ? '!!document.querySelector(".composer textarea") && !document.querySelector(".composer textarea").disabled' : '!!document.querySelector(".unsupported")')
    return sessionId
  }

  const main = await page(false, 1000, 680)
  const sticky = await page(true, 340, 480)
  await screenshot(main, 'timeline')
  await screenshot(sticky, 'sticky')

  await check('两个布局与初始记录正确，纯浏览器有明确宿主提示', async () => {
    assert.equal(await evaluate(main, 'document.querySelectorAll(".day-column").length'), 3)
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".day-heading").length'), 3)
    assert.equal(await evaluate(main, 'document.querySelector(".app-footer button").disabled'), true)
    assert.equal(await evaluate(sticky, '!!document.querySelector(".app-footer button")'), false)
    for (const page of [main, sticky]) {
      assert.doesNotMatch(await evaluate(page, 'document.querySelector(".app-footer").textContent'), /记录日期|创建日/)
    }
    const unsupported = await page(false, 700, 500, false)
    assert.equal(await evaluate(unsupported, '!!window.utools'), false)
  })
  await check('中文输入法不误提交，新增任务后两个窗口各读取一次', async () => {
    await fill(sticky, '.composer textarea', '浏览器自检新任务')
    await evaluate(sticky, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))`)
    assert.equal(await evaluate(sticky, 'window.testHost.getState().docs.length'), 7)
    for (const page of [main, sticky]) await evaluate(page, 'window.testHost.taskReads = 0')
    await click(sticky, '.add-button')
    await until(main, 'window.testHost.getState().docs.length === 8 && document.querySelectorAll(".task-row").length === 8')
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea").value'), '')
    for (const page of [main, sticky]) assert.equal(await evaluate(page, 'window.testHost.taskReads'), 1)
  })
  await check('保存失败保留输入，重试不重复创建', async () => {
    await fill(sticky, '.composer textarea', '保存失败后保留的草稿')
    await evaluate(sticky, 'window.testHost.failNext = true')
    await click(sticky, '.add-button')
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea").value'), '保存失败后保留的草稿')
    assert.equal(await evaluate(sticky, 'window.testHost.getState().docs.length'), 8)
    assert.match(await evaluate(sticky, 'document.querySelector(".composer-wrap .inline-error").textContent'), /保存失败/)
    await click(sticky, '.add-button')
    assert.equal(await evaluate(sticky, 'window.testHost.getState().docs.length'), 9)
  })
  await check('启动开关默认关闭，与显示设置互不覆盖，切换不立即开关窗口', async () => {
    await click(main, '[aria-label="设置"]')
    assert.equal(await evaluate(main, 'document.querySelector("[name=autoOpenSticky]").checked'), false)
    await click(main, '[name="autoOpenSticky"]')
    await click(main, 'input[name="completed"][value="false"]')
    assert.deepEqual(await evaluate(main, 'window.testHost.getState().settings'), { autoOpenSticky: true, showCompleted: false })
    await click(main, 'input[name="completed"][value="true"]')
    assert.deepEqual(await evaluate(main, 'window.testHost.getState().settings'), { autoOpenSticky: true, showCompleted: true })
    await evaluate(main, 'window.testHost.failSettingsNext = true')
    await click(main, '[name="autoOpenSticky"]')
    assert.equal(await evaluate(main, 'document.querySelector("[name=autoOpenSticky]").checked'), true)
    assert.equal(await evaluate(main, '!!window.testHost.openedSticky || !!window.testHost.closedSticky'), false)
    await click(main, '[aria-label="关闭设置"]')
  })
  await check('设置只隐藏快贴完成项，主界面保留完整记录', async () => {
    await click(main, '[aria-label="设置"]')
    await screenshot(main, 'settings')
    await click(main, 'input[name="completed"][value="false"]')
    await click(main, '[aria-label="关闭设置"]')
    await until(sticky, `!document.querySelector('${row('c')}')`)
    assert.equal(await evaluate(main, `!!document.querySelector('${row('c')}')`), true)
    assert.equal(await evaluate(main, 'window.testHost.getState().settings.autoOpenSticky'), true)
  })
  await check('快贴设置移除透明度滑块，贴边设置可保存并在失败时回滚', async () => {
    await fill(sticky, '.composer textarea', '设置调整时保留的草稿')
    await click(main, '[aria-label="设置"]')
    assert.equal(await evaluate(main, '!!document.querySelector(".settings-dialog input[type=range]")'), false)
    assert.equal(await evaluate(main, 'document.querySelector("[name=edgeCollapse]").checked'), false)
    await click(main, '[name=edgeCollapse]')
    assert.deepEqual(await evaluate(main, 'window.testHost.getState().settings'), { autoOpenSticky: true, showCompleted: false, edgeCollapse: true })
    await evaluate(main, 'window.testHost.failSettingsNext = true')
    await click(main, '[name=edgeCollapse]')
    assert.equal(await evaluate(main, 'document.querySelector("[name=edgeCollapse]").checked'), true)
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea").value'), '设置调整时保留的草稿')
    await click(main, '[aria-label="关闭设置"]')
    await click(main, '[aria-label="设置"]')
    await screenshot(main, 'settings')
    await click(main, '[aria-label="关闭设置"]')
    await fill(sticky, '.composer textarea', '')
  })
  await check('原生收起不切换界面或创建细条，草稿与滚动位置保留', async () => {
    await fill(sticky, '.composer textarea', '收起后仍在的草稿')
    const before = await evaluate(sticky, 'document.querySelectorAll(".task-row").length')
    await evaluate(sticky, 'window.testHost.composerNode = document.querySelector(".composer textarea"); document.querySelector(".sticky-list").scrollTop = 30; window.testHost.collapse("right")')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).display'), 'flex')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).transform'), 'none')
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea") === window.testHost.composerNode'), true)
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".edge-handle").length'), 0)
    assert.equal(await evaluate(sticky, 'document.documentElement.scrollWidth <= innerWidth'), true)
    await evaluate(sticky, 'window.testHost.dock(null)')
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 480, deviceScaleFactor: 1, mobile: false }, sticky)
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea").value'), '收起后仍在的草稿')
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".task-row").length'), before)
    assert.ok(await evaluate(sticky, 'document.querySelector(".sticky-list").scrollTop > 0'))
    await fill(sticky, '.composer textarea', '')
    await evaluate(sticky, 'document.querySelector(".sticky-list").scrollTop = 0; window.testHost.dock(null)')
  })
  await check('快贴固定使用毛玻璃覆盖层，鼠标与焦点事件不改样式，失败说明可见', async () => {
    const before = await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).backgroundColor')
    assert.equal(before, 'rgba(248, 249, 254, 0.75)')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".task-text")).opacity'), '1')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".task-row:not(.completed) .task-text")).color'), 'rgb(24, 32, 45)')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".app-footer")).color'), 'rgb(62, 75, 101)')
    await evaluate(sticky, 'document.documentElement.dispatchEvent(new PointerEvent("pointerleave")); document.documentElement.dispatchEvent(new PointerEvent("pointerenter")); window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus"))')
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).backgroundColor'), before)
    await evaluate(main, 'window.testHost.setAppearance({ acrylic: false, reason: "当前环境不支持毛玻璃，已使用实色背景。" })')
    await evaluate(sticky, 'window.testHost.setAppearance({ acrylic: false, reason: "当前环境不支持毛玻璃，已使用实色背景。" })')
    await click(main, '[aria-label="设置"]')
    assert.match(await evaluate(main, 'document.querySelector(".settings-dialog [role=status]").textContent'), /实色背景/)
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).backgroundColor'), 'rgb(248, 249, 254)')
    await click(main, '[aria-label="关闭设置"]')
    for (const page of [main, sticky]) await evaluate(page, 'window.testHost.setAppearance({ acrylic: true, reason: "" })')
  })
  await check('鼠标移出延迟 120 毫秒请求收起，快速移回取消，页面只接收窗口状态', async () => {
    await send('Page.bringToFront', {}, sticky)
    await evaluate(sticky, 'window.testHost.dock("top"); window.testHost.windowEvents = []; document.documentElement.dispatchEvent(new PointerEvent("pointerenter")); document.documentElement.dispatchEvent(new PointerEvent("pointerleave")); setTimeout(() => document.documentElement.dispatchEvent(new PointerEvent("pointerenter")), 40)')
    await sleep(220)
    assert.equal(await evaluate(sticky, 'window.testHost.windowEvents.length'), 0)
    await evaluate(sticky, 'window.testHost.leaveTime = performance.now(); document.documentElement.dispatchEvent(new PointerEvent("pointerleave"))')
    await sleep(50)
    assert.equal(await evaluate(sticky, 'window.testHost.windowEvents.length'), 0)
    await until(sticky, 'window.quickNote.getWindowState().phase === "collapsed"')
    const timing = await evaluate(sticky, 'window.testHost.windowEvents[0].time - window.testHost.leaveTime')
    assert.ok(timing >= 110 && timing < 500, `收起请求延迟 ${timing}ms`)
    assert.equal(await evaluate(sticky, 'typeof window.quickNote.advanceStickyAnimation'), 'undefined')
    assert.deepEqual(await evaluate(sticky, '(() => { const rect = document.querySelector(".sticky-app").getBoundingClientRect(); return [rect.width, rect.height] })()'), [340, 480])
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-app")).transform'), 'none')
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".edge-handle").length'), 0)
    await evaluate(sticky, 'document.documentElement.dispatchEvent(new PointerEvent("pointerenter"))')
    await until(sticky, 'window.quickNote.getWindowState().phase === "expanded"')
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 480, deviceScaleFactor: 1, mobile: false }, sticky)
    await evaluate(sticky, 'window.testHost.dock(null)')
  })
  await check('草稿和中文选词阻止收起，结束后恢复；减少动态效果偏好传给宿主', async () => {
    await fill(sticky, '.composer textarea', '正在输入的内容')
    await evaluate(sticky, 'window.testHost.dock("right"); window.testHost.windowEvents = []; document.documentElement.dispatchEvent(new PointerEvent("pointerleave"))')
    await sleep(240)
    assert.equal(await evaluate(sticky, 'window.testHost.windowEvents.length'), 0)
    await evaluate(sticky, 'document.querySelector(".composer textarea").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))')
    await fill(sticky, '.composer textarea', '')
    await sleep(240)
    assert.equal(await evaluate(sticky, 'window.testHost.windowEvents.length'), 0)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sticky)
    await evaluate(sticky, 'document.querySelector(".composer textarea").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))')
    await until(sticky, 'window.quickNote.getWindowState().phase === "collapsed"')
    assert.equal(await evaluate(sticky, 'window.testHost.interaction.reducedMotion'), true)
    await evaluate(sticky, 'document.documentElement.dispatchEvent(new PointerEvent("pointerenter"))')
    await until(sticky, 'window.quickNote.getWindowState().phase === "expanded"')
    await evaluate(sticky, 'window.testHost.dock(null)')
    await send('Emulation.setEmulatedMedia', { features: [] }, sticky)
  })
  await check('实际鼠标移出和移入页面边缘，只用指针事件也能收起与展开', async () => {
    await send('Page.bringToFront', {}, sticky)
    await evaluate(sticky, 'window.testHost.dock("top")')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 170, y: 200 }, sticky)
    await until(sticky, 'window.testHost.interaction.inside')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 200 }, sticky)
    await until(sticky, 'window.quickNote.getWindowState().phase === "collapsed"')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 170, y: 200 }, sticky)
    await until(sticky, 'window.quickNote.getWindowState().phase === "expanded"')
    await evaluate(sticky, 'window.testHost.dock(null)')
  })
  await check('标题栏使用指针捕获拖动，操作按钮不会开始拖动', async () => {
    await send('Page.bringToFront', {}, sticky)
    await evaluate(sticky, 'window.testHost.windowEvents = []')
    await pointerClick(sticky, '.window-actions button')
    assert.equal(await evaluate(sticky, 'window.testHost.windowEvents.length'), 0)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 110, y: 28, button: 'left', clickCount: 1 }, sticky)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 36, buttons: 1, button: 'left' }, sticky)
    await sleep(50)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 36, button: 'left', clickCount: 1 }, sticky)
    assert.deepEqual(await evaluate(sticky, 'window.testHost.windowEvents.map(item => item.event)'), ['drag-start', 'drag-move', 'drag-end'])
    assert.equal(await evaluate(sticky, 'getComputedStyle(document.querySelector(".sticky-header")).webkitAppRegion'), 'none')
  })
  await check('吸附后回报鼠标已在窗口外时，无需新的离开事件即可收起', async () => {
    await evaluate(sticky, 'window.testHost.dock("right"); window.testHost.dragEndInside = false; window.testHost.windowEvents = []')
    await pointerClick(sticky, '.sticky-brand')
    await until(sticky, 'window.quickNote.getWindowState().phase === "collapsed"')
    assert.ok(await evaluate(sticky, 'window.testHost.windowEvents.some(item => item.event === "collapse")'))
    await evaluate(sticky, 'window.testHost.dragEndInside = true; document.documentElement.dispatchEvent(new PointerEvent("pointerenter"))')
    await until(sticky, 'window.quickNote.getWindowState().phase === "expanded"')
    await evaluate(sticky, 'window.testHost.dock(null)')
  })
  await check('行内编辑没有操作按钮，Enter 和点击外部保存，Esc 取消', async () => {
    await click(sticky, `${row('b')} .task-text`)
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".edit-actions, .small-primary").length'), 0)
    await fill(sticky, `${row('b')} textarea`, '回车保存的内容')
    await screenshot(sticky, 'editing-inline')
    await press(sticky, `${row('b')} textarea`, 'Enter')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '回车保存的内容')
    await click(sticky, `${row('b')} .task-text`)
    await fill(sticky, `${row('b')} textarea`, '点击外部保存的内容')
    await pointerClick(sticky, '.composer textarea')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '点击外部保存的内容')
    assert.equal(await evaluate(sticky, 'document.activeElement === document.querySelector(".composer textarea")'), true)
    await click(sticky, `${row('b')} .task-text`)
    await fill(sticky, `${row('b')} textarea`, '点击日期标题也会保存')
    await pointerClick(sticky, '.day-heading')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '点击日期标题也会保存')
    await click(sticky, `${row('b')} .task-text`)
    await fill(sticky, `${row('b')} textarea`, '这段不应保存')
    await press(sticky, `${row('b')} textarea`, 'Escape')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '点击日期标题也会保存')
    const revision = await evaluate(sticky, `window.utools.db.get('quick-note/task/b')._rev`)
    await click(sticky, `${row('b')} .task-text`)
    await pointerClick(sticky, '.composer textarea')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b')._rev`), revision)
  })
  await check('空白或保存失败时保留编辑草稿，重试后可正常保存', async () => {
    await click(sticky, `${row('b')} .task-text`)
    await fill(sticky, `${row('b')} textarea`, '   ')
    await pointerClick(sticky, '.composer textarea')
    assert.equal(await evaluate(sticky, `!!document.querySelector('${row('b')} textarea')`), true)
    assert.match(await evaluate(sticky, `document.querySelector('${row('b')} .inline-error').textContent`), /写点内容/)
    await fill(sticky, `${row('b')} textarea`, '失败后重试的正文')
    await evaluate(sticky, 'window.testHost.failNext = true')
    await press(sticky, `${row('b')} textarea`, 'Enter')
    assert.equal(await evaluate(sticky, `document.querySelector('${row('b')} textarea').value`), '失败后重试的正文')
    await press(sticky, `${row('b')} textarea`, 'Enter')
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '失败后重试的正文')
  })
  await check('中文组词期间失焦等待输入完成后保存，不提交半成品', async () => {
    await click(sticky, `${row('b')} .task-text`)
    await evaluate(sticky, `(() => { const input = document.querySelector('${row('b')} textarea'); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = '完整的中文输入'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); input.blur(); })()`)
    assert.equal(await evaluate(sticky, `window.utools.db.get('quick-note/task/b').text`), '失败后重试的正文')
    await evaluate(sticky, `document.querySelector('${row('b')} textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`)
    await until(sticky, `window.utools.db.get('quick-note/task/b').text === '完整的中文输入'`)
  })
  await check('完成后保留 5 秒，期间可恢复，随后从主界面仍能恢复', async () => {
    await click(sticky, `${row('a')} .task-checkbox`)
    assert.equal(await evaluate(sticky, `!!document.querySelector('${row('a')} .hide-hint')`), true)
    await sleep(200)
    await click(sticky, `${row('a')} .task-checkbox`)
    assert.equal(await evaluate(sticky, `document.querySelector('${row('a')} .task-checkbox').checked`), false)
    await click(sticky, `${row('a')} .task-checkbox`)
    await until(sticky, `!document.querySelector('${row('a')}')`, 7000)
    assert.equal(await evaluate(main, `document.querySelector('${row('a')} .task-checkbox').checked`), true)
    await click(main, `${row('a')} .task-checkbox`)
    await until(sticky, `!!document.querySelector('${row('a')}')`)
  })
  await check('后台更新保留编辑草稿与焦点，冲突必须核对后保存', async () => {
    await click(sticky, `${row('d')} .task-text`)
    await fill(sticky, `${row('d')} textarea`, '我的历史任务草稿')
    await evaluate(main, `(() => { const task = window.utools.db.get('quick-note/task/d'); window.utools.db.put({ ...task, text: '后台已保存的内容' }); window.testHost.notify(); })()`)
    assert.equal(await evaluate(sticky, `document.querySelector('${row('d')} textarea').value`), '我的历史任务草稿')
    assert.equal(await evaluate(sticky, `document.activeElement === document.querySelector('${row('d')} textarea')`), true)
    await press(sticky, `${row('d')} textarea`, 'Enter')
    assert.equal(await evaluate(sticky, `!!document.querySelector('${row('d')} .conflict-box')`), true)
    await click(sticky, `${row('d')} .conflict-box button`)
    await press(sticky, `${row('d')} textarea`, 'Enter')
    await until(main, `document.querySelector('${row('d')} .task-text').textContent === '我的历史任务草稿'`)
  })
  await check('后台完成与隐藏设置不会销毁正在编辑的草稿', async () => {
    await click(sticky, `${row('a')} .task-text`)
    await fill(sticky, `${row('a')} textarea`, '不能因为隐藏而丢失的草稿')
    await evaluate(main, `(() => { const task = window.utools.db.get('quick-note/task/a'); window.utools.db.put({ ...task, completedAt: Date.now() }); window.testHost.notify(); })()`)
    await sleep(5200)
    assert.equal(await evaluate(sticky, `document.querySelector('${row('a')} textarea').value`), '不能因为隐藏而丢失的草稿')
    await evaluate(sticky, `document.querySelector('${row('a')} textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await until(sticky, `!document.querySelector('${row('a')}')`)
  })
  await check('删除必须确认，完成后两个窗口都移除记录', async () => {
    await click(sticky, `${row('f')} .task-more`)
    await click(sticky, `${row('f')} .row-actions .danger`)
    assert.equal(await evaluate(main, `!!document.querySelector('${row('f')}')`), true)
    await click(sticky, `${row('f')} .delete-confirm .danger`)
    await until(main, `!document.querySelector('${row('f')}')`)
  })
  await check('纯文本安全显示，换行编辑保留', async () => {
    const value = '<img src=x onerror="window.bad=true">\n第二行'
    await fill(sticky, '.composer textarea', value)
    await click(sticky, '.add-button')
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".task-row img").length'), 0)
    assert.equal(await evaluate(sticky, '!!window.bad'), false)
    assert.equal(await evaluate(sticky, `Array.from(document.querySelectorAll('.task-text')).some(node => node.textContent === ${JSON.stringify(value)})`), true)
  })
  await check('远端删除仍保留编辑中的草稿，不会自动复活任务', async () => {
    await click(sticky, `${row('d')} .task-text`)
    await fill(sticky, `${row('d')} textarea`, '删除后仍应保留的未提交草稿')
    await evaluate(main, `(() => { window.utools.db.remove(window.utools.db.get('quick-note/task/d')); window.testHost.notify(); })()`)
    assert.equal(await evaluate(sticky, `document.querySelector('${row('d')} textarea').value`), '删除后仍应保留的未提交草稿')
    await press(sticky, `${row('d')} textarea`, 'Enter')
    assert.match(await evaluate(sticky, `document.querySelector('${row('d')} .inline-error').textContent`), /已被删除/)
    assert.equal(await evaluate(main, `window.utools.db.get('quick-note/task/d')`), null)
    await evaluate(sticky, `document.querySelector('${row('d')} textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await until(sticky, `!document.querySelector('${row('d')}')`)
  })
  await check('重新加载保留任务与设置；最小尺寸无横向溢出', async () => {
    await send('Page.reload', {}, sticky)
    await until(sticky, '!!document.querySelector(".composer textarea")')
    assert.equal(await evaluate(sticky, 'window.testHost.getState().settings.showCompleted'), false)
    assert.equal(await evaluate(sticky, 'window.testHost.getState().settings.autoOpenSticky'), true)
    await send('Emulation.setDeviceMetricsOverride', { width: 280, height: 240, deviceScaleFactor: 1, mobile: false }, sticky)
    assert.equal(await evaluate(sticky, 'document.documentElement.scrollWidth <= innerWidth'), true)
    await screenshot(sticky, 'sticky-minimum')
  })
  await check('窗口错误提示不会被焦点刷新清掉，可手动重试清除', async () => {
    await evaluate(main, `window.testHost.reportError('窗口创建失败，请重试。'); window.dispatchEvent(new Event('focus'))`)
    assert.match(await evaluate(main, 'document.querySelector(".global-error").textContent'), /窗口创建失败/)
    await click(main, '.global-error button')
    assert.equal(await evaluate(main, '!!document.querySelector(".global-error")'), false)
  })
  await check('1,000 条跨日记录保持完整，并可滚动浏览', async () => {
    const records = Array.from({ length: 1000 }, (_, index) => {
      const date = new Date()
      date.setDate(date.getDate() - index % 90)
      return { _id: `quick-note/task/load-${index}`, _rev: '1-test', text: `性能自检记录 ${index}，确认多日列表滚动与长文字换行。`, createdAt: date.getTime() + index, createdDay: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, completedAt: null }
    })
    const start = performance.now()
    await evaluate(main, `window.testHost.reset(${JSON.stringify(records)})`)
    await until(main, 'document.querySelectorAll(".task-row").length === 1000')
    await until(sticky, 'document.querySelectorAll(".task-row").length === 1000')
    assert.equal(await evaluate(main, 'document.querySelectorAll(".day-column").length'), 90)
    assert.equal(await evaluate(sticky, 'document.querySelector(".sticky-list").scrollHeight > document.querySelector(".sticky-list").clientHeight'), true)
    console.log(`1,000 records rendered in ${Math.round(performance.now() - start)} ms (two mocked windows)`)
  })
  await check('主界面横向、日期列和快贴滚动时显示滚动条，停止后隐藏且布局稳定', async () => {
    const hidden = 'rgba(0, 0, 0, 0)'
    for (const [view, selector, position] of [
      [main, '.column-list', 'scrollTop'],
      [main, '.timeline-board', 'scrollLeft'],
      [sticky, '.sticky-list', 'scrollTop'],
    ]) {
      await send('Page.bringToFront', {}, view)
      const scroller = `document.querySelector(${JSON.stringify(selector)})`
      const thumb = `getComputedStyle(${scroller}, "::-webkit-scrollbar-thumb").backgroundColor`
      const size = `[${scroller}.clientWidth, ${scroller}.clientHeight]`
      await until(view, `${thumb} === "${hidden}"`)
      const before = await evaluate(view, size)
      await evaluate(view, `${scroller}.${position} = 120`)
      assert.ok(await evaluate(view, `${scroller}.${position} > 0`), selector)
      await until(view, `${scroller}.hasAttribute("data-scrolling")`)
      await until(view, `${thumb} !== "${hidden}"`)
      assert.deepEqual(await evaluate(view, size), before, selector)
      await until(view, `${thumb} === "${hidden}"`)
    }
  })
  await check('只有今天时不显示时间线，空列表保留输入入口和今天列', async () => {
    const [, , completedToday] = exampleTasks()
    await evaluate(main, `window.testHost.reset(${JSON.stringify([completedToday])})`)
    await until(sticky, 'document.querySelectorAll(".task-row").length === 1')
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".day-heading").length'), 0)
    assert.equal(await evaluate(main, `document.querySelector('${collapseButton}').disabled`), true)
    await evaluate(main, 'window.testHost.reset([])')
    await until(sticky, '!!document.querySelector(".empty-state")')
    assert.equal(await evaluate(main, 'document.querySelectorAll(".day-column").length'), 1)
    assert.equal(await evaluate(sticky, 'document.querySelector(".composer textarea").disabled'), false)
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 480, deviceScaleFactor: 1, mobile: false }, sticky)
    await screenshot(sticky, 'sticky-empty')
  })
  await check('时间线双箭头只收起全完成的历史日期，保留今天列，窄窗口可用键盘操作', async () => {
    const [a, , , d, e, f, g] = exampleTasks()
    a.completedAt = Date.now() - 6000
    d.completedAt = a.completedAt
    const records = [a, d, e, f, g]
    const days = 'Array.from(document.querySelectorAll(".day-column"), column => column.dataset.day)'
    const button = collapseButton
    const buttonSelector = JSON.stringify(button)
    const icon = `document.querySelector(${buttonSelector}).querySelector("path").getAttribute("d")`
    await evaluate(main, `window.testHost.reset(${JSON.stringify(records)})`)
    await until(sticky, 'document.querySelectorAll(".task-row").length === 5')
    const originalDays = await evaluate(main, days)
    assert.deepEqual(originalDays, [a.createdDay, d.createdDay, f.createdDay])
    assert.equal(await evaluate(main, `document.querySelector(${buttonSelector}).textContent.trim()`), '')
    assert.equal(await evaluate(main, `document.querySelector(${buttonSelector}).title`), '收起已完成的历史日期')
    const collapseIcon = await evaluate(main, icon)

    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 480, deviceScaleFactor: 1, mobile: false }, main)
    const buttonBounds = `JSON.stringify(document.querySelector(${buttonSelector}).getBoundingClientRect())`
    const originalBounds = await evaluate(main, buttonBounds)
    const { left, right, top, bottom } = JSON.parse(originalBounds)
    assert.ok(left > 170 && right <= 340 && top > 240 && bottom <= 480)
    assert.ok(await evaluate(main, 'document.querySelector(".timeline-board").scrollWidth > innerWidth'))
    await evaluate(main, 'document.querySelector(".timeline-board").scrollLeft = 400')
    assert.ok(await evaluate(main, 'document.querySelector(".timeline-board").scrollLeft > 0'))
    assert.equal(await evaluate(main, buttonBounds), originalBounds)

    await send('Page.bringToFront', {}, main)
    await evaluate(main, `document.querySelector(${buttonSelector}).focus()`)
    assert.equal(await evaluate(main, `document.activeElement === document.querySelector(${buttonSelector})`), true)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }, main)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, main)
    await until(main, `document.querySelector(${buttonSelector}).getAttribute("aria-expanded") === "false"`)
    assert.equal(await evaluate(main, `document.querySelector(${buttonSelector}).getAttribute("aria-label")`), '展开已完成的历史日期')
    assert.notEqual(await evaluate(main, icon), collapseIcon)
    assert.deepEqual(await evaluate(main, days), [a.createdDay, f.createdDay])
    assert.equal(await evaluate(main, `!!document.querySelector('.today-column ${row('a')}.completed')`), true)
    assert.equal(await evaluate(main, `!!document.querySelector('${row('g')}')`), true)
    assert.equal(await evaluate(sticky, 'document.querySelectorAll(".task-row").length'), 5)
    assert.deepEqual(await evaluate(main, 'window.testHost.getState().docs'), records)
    await click(main, button)
    assert.equal(await evaluate(main, icon), collapseIcon)
    assert.deepEqual(await evaluate(main, days), originalDays)

    await click(main, button)
    await evaluate(main, `document.querySelector('${row('f')} input').focus()`)
    await click(sticky, `${row('f')} .task-checkbox`)
    await until(main, 'document.querySelectorAll(".day-column").length === 1')
    assert.deepEqual(await evaluate(main, days), [a.createdDay])
    assert.equal(await evaluate(main, `document.activeElement === document.querySelector(${buttonSelector})`), true)
    assert.equal(await evaluate(main, `document.querySelector(${buttonSelector}).disabled`), false)
    assert.equal(await evaluate(main, 'document.querySelector(".composer textarea").disabled'), false)
    await click(sticky, `${row('f')} .task-checkbox`)
    await until(main, `!!document.querySelector('${row('f')}')`)
    assert.deepEqual(await evaluate(main, days), [a.createdDay, f.createdDay])

    await send('Page.reload', {}, main)
    await until(main, `document.querySelector(${buttonSelector})?.getAttribute("aria-expanded") === "true" && document.querySelectorAll(".day-column").length === 3`)
    assert.deepEqual(await evaluate(main, days), originalDays)
  })
  await check('收起时保留空的今天列和未保存的编辑草稿，退出编辑后重新判断', async () => {
    const [, , , d, , , g] = exampleTasks()
    const button = '.app-footer button'
    const editor = `${row('d')} textarea`
    const draft = '收起日期时保留的草稿'
    await evaluate(main, `window.testHost.reset(${JSON.stringify([d, g])})`)
    await until(sticky, `!!document.querySelector('${row('d')}')`)
    await click(main, button)
    assert.equal(await evaluate(main, '!!document.querySelector(".today-column .column-empty")'), true)
    await click(main, `${row('d')} .task-text`)
    await fill(main, editor, draft)
    await click(sticky, `${row('d')} .task-checkbox`)
    await until(main, `!!document.querySelector('${row('d')}.completed')`)
    assert.equal(await evaluate(main, `document.querySelector('${editor}').value`), draft)
    assert.equal(await evaluate(main, `document.activeElement === document.querySelector('${editor}')`), true)
    await press(main, editor, 'Escape')
    await until(main, 'document.querySelectorAll(".day-column").length === 1')
    assert.equal(await evaluate(main, '!!document.querySelector(".today-column .column-empty")'), true)
    await click(main, button)
    assert.equal(await evaluate(main, 'document.querySelectorAll(".day-column").length'), 3)
    assert.equal(await evaluate(main, `document.querySelector('${row('d')} .task-text').textContent`), d.text)
  })
  assert.deepEqual(runtimeErrors, [], '浏览器不应出现未捕获异常或 Vue 错误')
  await writeFile(join(artifacts, 'browser-check.json'), JSON.stringify({ testedAt: new Date().toISOString(), environment: 'Headless Chrome; mocked uTools storage and IPC, no live host data', passed: results, runtimeErrors }, null, 2))
  console.log(`Browser checks passed: ${results.length}`)
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close') } catch {}
    socket.close()
  }
  if (browser && browser.exitCode === null) {
    await Promise.race([once(browser, 'exit'), sleep(2000)])
    if (browser.exitCode === null) browser.kill()
  }
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  if (profile) {
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep + 'quick-note-check-'))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}

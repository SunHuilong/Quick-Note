import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import path from 'node:path'
import { createRepository } from '../src/repository.js'

const require = createRequire(import.meta.url)
const windows = require('../public/window-state.cjs')
const mcp = require('../public/mcp-tools.cjs')
const config = require('../public/plugin.json')
const preload = readFileSync(new URL('../public/preload.js', import.meta.url), 'utf8')

test('安装入口使用 .js 和 CommonJS，图标默认功能与手动入口分离', () => {
  assert.match(config.preload, /\.js$/i)
  assert.ok(existsSync(new URL(`../public/${config.preload}`, import.meta.url)))
  assert.equal(existsSync(new URL('../public/preload.cjs', import.meta.url)), false)
  assert.equal(require('../public/package.json').type, 'commonjs')
  assert.equal(config.features[0].code, 'home')
  assert.ok(config.features[0].cmds.includes('快记'))
  assert.deepEqual(config.features.find(feature => feature.code === 'sticky').cmds, ['快贴'])
})

function fixture(options = {}) {
  const files = new Map()
  const controls = { settings: options.settings ?? null, failCreate: false, failRead: false, cursor: { x: 100, y: 100 }, ...options }
  const fs = {
    existsSync: key => files.has(key),
    readFileSync: key => files.get(key),
    mkdirSync() {},
    writeFileSync: (key, value) => files.set(key, value),
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
  }
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  let enter
  let pull
  let load
  let handle
  let pin = true
  let mainVisible = true
  let focus = 'main'
  let hidden = 0
  let mainShows = 0
  let exitHandlers = 0
  let created = 0
  let closed = 0
  const timers = new Set()
  let clock = 0
  const events = []
  const errors = []
  const redirects = []
  const tools = new Map()
  const parent = { ipc: new EventEmitter() }
  const child = { ipc: new EventEmitter() }
  const base = {
    getPluginLocalDataPath: () => 'C:\\fake-quick-note-data',
    getAllDisplays: () => [primary],
    getDisplayNearestPoint: () => primary,
    getDisplayMatching: () => primary,
    getCursorScreenPoint: () => controls.cursor,
    hideMainWindow() { mainVisible = false; hidden++; events.push('hide-main') },
    showMainWindow() { mainVisible = true; focus = 'main'; mainShows++; events.push('show-main'); return true },
    onPluginEnter: callback => { enter = callback },
    onPluginOut: () => { exitHandlers++ },
    onDbPull: callback => { pull = callback },
    redirect: args => redirects.push(args),
    registerTool: (name, handler) => tools.set(name, handler),
    db: { allDocs: () => [] },
    dbStorage: {
      getItem(key) {
        assert.equal(key, 'quick-note/settings')
        if (controls.failRead) throw new Error('设置读取失败')
        return controls.settings
      },
    },
  }
  const parentHost = {
    ...base,
    createBrowserWindow(url, options, callback) {
      if (controls.failCreate) throw new Error('窗口创建失败')
      load = callback
      created++
      let destroyed = false
      let visible = false
      let bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      pin = options.alwaysOnTop
      child.ipc.removeAllListeners()
      handle = {
        isDestroyed() {
          if (destroyed) throw new Error('invalid')
          return false
        },
        isVisible: () => visible,
        getBounds: () => bounds,
        setBounds: value => { bounds = value },
        setPosition: (x, y) => { bounds = { ...bounds, x, y } },
        setBackgroundMaterial: value => { handle.material = value },
        setBackgroundColor: value => { handle.background = value },
        setMinimumSize() {},
        setIgnoreMouseEvents(value) { handle.ignored = value },
        isAlwaysOnTop: () => pin,
        setAlwaysOnTop: value => { pin = value },
        show() { visible = true },
        showInactive() { visible = true; events.push('show-sticky-inactive') },
        focus() { focus = 'sticky'; events.push('focus-sticky') },
        close() { destroyed = true; visible = false; closed++ },
        webContents: { send: (channel, value) => child.ipc.emit(channel, {}, value) },
      }
      return handle
    },
  }
  const childHost = {
    ...base,
    onPluginEnter: () => assert.fail('子窗口不能重复注册插件入口'),
    onDbPull: () => assert.fail('云同步事件应只由父窗口注册并转发'),
    registerTool: () => assert.fail('子窗口不能重复注册 MCP 工具'),
    sendToParent: (channel, value) => parent.ipc.emit(channel, {}, value),
  }
  function loadPreload(target, sticky, utools) {
    target.events = {}
    target.window = {
      location: { search: sticky ? '?view=sticky' : '' },
      addEventListener: (name, callback) => { target.events[name] = callback },
    }
    runInNewContext(preload, {
      window: target.window, utools, URLSearchParams,
      require(name) {
        if (name === 'electron') return { ipcRenderer: target.ipc }
        if (name === 'node:fs') return fs
        if (name === 'node:path') return path
        if (name === './plugin.json') return config
        if (name === './repository.cjs') return { createRepository }
        if (name === './mcp-tools.cjs') return mcp
        if (name === './windows-acrylic.cjs') return { applyWindowsAcrylic: async () => false }
        if (name === './window-state.cjs') return {
          createWindowManager: options => windows.createWindowManager({ ...options, supportsAcrylic: true,
            every(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer },
            stop: timer => timers.delete(timer), now: () => clock,
          }),
        }
        assert.fail(`Unexpected require: ${name}`)
      },
    })
    target.bridge = target.window.quickNote
  }
  loadPreload(parent, false, parentHost)
  parent.bridge.onError(message => errors.push(message))
  return {
    parent, child, controls, events, errors, tools,
    enter: code => enter({ code }),
    load() { loadPreload(child, true, childHost); load() },
    background() { mainVisible = false; focus = 'other' },
    pull: () => pull([]),
    tick: () => [...timers].find(timer => timer.delay === 1000)?.callback(),
    advance(ms) { clock += ms; [...timers].filter(timer => timer.delay < 1000).forEach(timer => timer.callback()) },
    stats: () => ({ mainVisible, focus, hidden, mainShows, pin, created, closed, exitHandlers, redirects, handle, intervals: timers.size }),
  }
}

async function manualSticky(fixture) {
  const pending = fixture.enter('sticky')
  fixture.load()
  await pending
}

test('冷启动默认显示主界面，不打开快贴', async () => {
  const f = fixture()
  f.background()
  await f.enter('home')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().focus, 'main')
  assert.equal(f.stats().created, 0)
  assert.equal(f.stats().hidden, 0)
})

test('MCP 调用不弹窗；工具已运行后再点击图标显示主界面', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  assert.equal(f.tools.size, 6)
  const result = f.tools.get('list_tasks')({})
  assert.equal(result.total, 0)
  assert.equal(f.stats().mainShows, 0)
  assert.equal(f.stats().created, 0)
  assert.equal(f.stats().hidden, 0)
  await f.enter('home')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().created, 0)
})

test('自动快贴开启时，必须显示成功后才能隐藏主界面', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  const pending = f.enter('home')
  assert.equal(f.stats().hidden, 0)
  assert.equal(f.stats().mainVisible, true)
  f.load()
  await pending
  assert.deepEqual(f.events, ['show-sticky-inactive', 'focus-sticky', 'hide-main'])
  assert.equal(f.stats().mainVisible, false)
  assert.equal(f.stats().focus, 'sticky')
})

test('已经运行后再次点图标显示主界面，保留快贴且不重复创建', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  const pending = f.enter('home')
  f.load()
  await pending
  await f.enter('home')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().focus, 'main')
  assert.equal(f.stats().handle.isVisible(), true)
  assert.equal(f.stats().created, 1)
  assert.equal(f.stats().hidden, 1)
})

test('手动关闭快贴不报错，再点图标只显示主界面，重新打开恢复窗口状态', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  const pending = f.enter('home')
  f.load()
  await pending
  const bounds = { x: 200, y: 150, width: 360, height: 600 }
  f.child.bridge.setPinned(false)
  f.stats().handle.setBounds(bounds)
  f.child.bridge.closeSticky()
  f.child.events.beforeunload?.()
  await f.enter('home')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().created, 1)
  assert.equal(f.stats().closed, 1)
  await manualSticky(f)
  assert.equal(f.stats().created, 2)
  assert.deepEqual(f.stats().handle.getBounds(), bounds)
  assert.equal(f.stats().pin, false)
  assert.deepEqual(f.errors, [])
})

test('宿主回收窗口后轮询正常结束，快贴可以重新打开', async () => {
  const f = fixture()
  await manualSticky(f)
  f.stats().handle.close()
  f.tick()
  assert.equal(f.stats().intervals, 0)
  await manualSticky(f)
  assert.equal(f.stats().created, 2)
  assert.deepEqual(f.errors, [])
})

test('后台隐藏不重置冷启动状态，修改开关也不会在本次运行弹窗', async () => {
  const f = fixture({ settings: { autoOpenSticky: false } })
  await f.enter('home')
  f.controls.settings = { autoOpenSticky: true }
  f.background()
  await f.enter('home')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().created, 0)
  assert.equal(f.stats().exitHandlers, 0)
})

test('明确的时间线入口忽略自动快贴开关，冷启动也显示主界面', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  f.background()
  await f.enter('timeline')
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().created, 0)
})

test('快贴尚未就绪时再次点图标，旧回调不能隐藏主窗或抢走焦点', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  const pending = f.enter('home')
  await f.enter('home')
  f.load()
  await pending
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().focus, 'main')
  assert.equal(f.stats().hidden, 0)
  assert.equal(f.events.includes('focus-sticky'), false)
})

test('手动打开快贴及重复唤起均不隐藏主界面', async () => {
  const f = fixture()
  await manualSticky(f)
  await f.parent.bridge.openSticky()
  assert.equal(f.stats().created, 1)
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().hidden, 0)
  assert.equal(f.stats().focus, 'sticky')
})

test('读取设置或创建快贴失败时，显示主界面并报告错误', async () => {
  for (const options of [{ failRead: true }, { settings: { autoOpenSticky: true }, failCreate: true }]) {
    const f = fixture(options)
    f.background()
    await f.enter('home')
    assert.equal(f.stats().mainVisible, true)
    assert.equal(f.stats().hidden, 0)
    assert.equal(f.errors.length, 1)
  }
})

test('显示快贴失败时，保留主界面并报告错误', async () => {
  const f = fixture({ settings: { autoOpenSticky: true } })
  const pending = f.enter('home')
  f.stats().handle.showInactive = () => { throw new Error('无法显示窗口') }
  f.load()
  await pending
  assert.equal(f.stats().mainVisible, true)
  assert.equal(f.stats().hidden, 0)
  assert.equal(f.stats().closed, 1)
  assert.match(f.errors[0], /无法显示窗口/)
})

test('数据变更各窗口只通知一次，子窗口消息不原路回传，云端拉取仍广播', async () => {
  const f = fixture()
  await manualSticky(f)
  let parentUpdates = 0
  let childUpdates = 0
  f.parent.bridge.onDataChanged(() => parentUpdates++)
  f.child.bridge.onDataChanged(() => childUpdates++)
  f.parent.bridge.notifyDataChanged()
  assert.equal(parentUpdates, 1)
  assert.equal(childUpdates, 1)
  f.child.bridge.notifyDataChanged()
  assert.equal(parentUpdates, 2)
  assert.equal(childUpdates, 2)
  f.pull()
  assert.equal(parentUpdates, 3)
  assert.equal(childUpdates, 3)
})

test('子窗口置顶、打开时间线、关闭仍通过限定接口工作', async () => {
  const f = fixture()
  await manualSticky(f)
  let reportedPin
  f.child.bridge.onPinnedChanged(value => { reportedPin = value })
  f.child.bridge.setPinned(false)
  assert.equal(f.stats().pin, false)
  assert.equal(reportedPin, false)
  assert.equal(f.child.bridge.isPinned(), false)
  f.child.bridge.openTimeline()
  assert.deepEqual(f.stats().redirects, ['快记时间线'])
  assert.ok(config.features.find(feature => feature.code === 'timeline').cmds.includes(f.stats().redirects[0]))
  f.child.bridge.closeSticky()
  assert.equal(f.stats().closed, 1)
  assert.equal(f.child.bridge.fs, undefined)
  assert.equal(f.child.bridge.require, undefined)
})

test('入口早于 Vue 加载时保留激活事件，监听器可注销', async () => {
  const f = fixture()
  await f.enter('home')
  let mainActivates = 0
  f.parent.bridge.onActivate(() => mainActivates++)
  assert.equal(mainActivates, 1)
  await manualSticky(f)
  let activates = 0
  const unsubscribe = f.child.bridge.onActivate(() => activates++)
  assert.equal(activates, 1)
  await f.enter('sticky')
  assert.equal(activates, 2)
  unsubscribe()
  await f.enter('sticky')
  assert.equal(activates, 2)
})

test('主界面后台时原生计时器独立收起与唤回，悬停不激活窗口', async () => {
  const f = fixture()
  await manualSticky(f)
  f.background()
  f.controls.settings = { edgeCollapse: true }
  f.parent.bridge.notifyDataChanged()
  assert.equal(f.stats().handle.material, 'acrylic')
  assert.equal(f.child.bridge.getAppearance().acrylic, true)
  f.stats().handle.setBounds({ x: 20, y: 300, width: 340, height: 480 })
  f.child.bridge.beginStickyDrag()
  f.child.bridge.moveStickyDrag()
  f.child.bridge.endStickyDrag()
  assert.equal(f.child.bridge.getWindowState().edge, 'left')
  f.child.bridge.setStickyInteraction({ inside: false, busy: false, reducedMotion: false })
  f.child.bridge.collapseSticky()
  assert.equal(f.child.bridge.getWindowState().phase, 'collapsing')
  assert.equal(f.child.bridge.advanceStickyAnimation, undefined)
  f.advance(180)
  assert.equal(f.child.bridge.getWindowState().phase, 'collapsed')
  assert.equal(f.stats().handle.ignored, true)
  f.controls.cursor = { x: 2, y: 540 }
  f.advance(50)
  assert.equal(f.child.bridge.getWindowState().phase, 'expanding')
  f.advance(160)
  assert.equal(f.child.bridge.getWindowState().phase, 'expanded')
  assert.equal(f.stats().focus, 'other')
  await f.parent.bridge.openSticky()
  assert.equal(f.stats().focus, 'sticky')
  assert.equal(f.stats().mainVisible, false)
  assert.equal(f.stats().handle.material, 'acrylic')
})

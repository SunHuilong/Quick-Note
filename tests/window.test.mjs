import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { fitBounds, nearestEdge, createWindowManager } = createRequire(import.meta.url)('../public/window-state.cjs')
const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const left = { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 720 } }

test('首次打开靠近屏幕右侧；断开显示器后将窗口移回可见区域', () => {
  assert.deepEqual(fitBounds({}, [primary], primary), { x: 1556, y: 48, width: 340, height: 480 })
  assert.deepEqual(fitBounds({ x: -1200, y: 50, width: 340, height: 480 }, [primary, left], primary), { x: -1200, y: 50, width: 340, height: 480 })
  assert.deepEqual(fitBounds({ x: -1200, y: 50, width: 340, height: 480 }, [primary], primary), { x: 0, y: 50, width: 340, height: 480 })
})

test('缩放和异常配置都限制在工作区内', () => {
  const bounds = fitBounds({ x: 1900, y: 1000, width: 9999, height: -1 }, [primary], primary)
  assert.deepEqual(bounds, { x: 0, y: 800, width: 1920, height: 240 })
  const bad = fitBounds({ x: null, y: 'a', width: '100', height: Infinity }, [primary], primary)
  assert.equal(bad.width, 340)
  assert.equal(bad.height, 480)
})

function managerFixture(initial = {}, preferences = {}, supportsAcrylic = true, applyWindowsAcrylic) {
  let saved = initial
  let saves = 0
  let created = 0
  const timers = new Set()
  let clock = 0
  let load
  let handle
  const errors = []
  const sent = []
  let focused = 0
  let shownInactive = 0
  let windowOptions
  let material
  let background
  let backgroundSetAfterShow
  let ignored = false
  let materialChanges = 0
  const controls = { cursor: { x: 0, y: 0 }, displays: [primary], failMaterial: false, missingMaterial: false, failMove: false, clampMove: false, settings: { edgeCollapse: false, ...preferences } }
  const utools = {
    getAllDisplays: () => controls.displays,
    getCursorScreenPoint: () => controls.cursor,
    getDisplayNearestPoint: () => primary,
    getDisplayMatching: bounds => controls.displays.find(({ workArea: a }) => bounds.x >= a.x && bounds.x < a.x + a.width) || primary,
    createBrowserWindow(url, options, callback) {
      assert.equal(url, 'index.html?view=sticky')
      assert.equal(options.webPreferences.preload, 'preload.js')
      assert.equal(options.backgroundColor, supportsAcrylic ? '#00000000' : '#F8F9FE')
      windowOptions = options
      created++
      load = callback
      let destroyed = false
      let bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      let pinned = options.alwaysOnTop
      let title = options.title
      handle = {
        isDestroyed: () => destroyed,
        getTitle: () => title,
        setTitle: value => { title = value },
        getBounds: () => bounds,
        // 模拟实机的最小尺寸限制，防止测试再次把“请求尺寸”当成“实际尺寸”。
        setBounds: value => { bounds = { ...value, width: Math.max(40, value.width), height: Math.max(40, value.height) } },
        setPosition(x, y) {
          for (const [index, value] of [x, y].entries()) {
            // Electron 的 int32 转换不接受负零，Number.isInteger(-0) 却会返回 true。
            if (!Number.isInteger(value) || Object.is(value, -0) || value < -2147483648 || value > 2147483647) {
              throw new Error(`Error processing argument at index ${index}, conversion failure from`)
            }
          }
          if (controls.failMove) throw new Error('测试：系统拒绝移动')
          bounds = { ...bounds, x: controls.clampMove ? Math.max(0, Math.min(x, 1920 - bounds.width)) : x, y: controls.clampMove ? Math.max(0, Math.min(y, 1040 - bounds.height)) : y }
        },
        setShape: () => assert.fail('原生移动不能调用裁切'),
        setBackgroundMaterial(value) { if (controls.failMaterial) throw new Error('材质不可用'); material = value; materialChanges++ },
        setBackgroundColor(value) {
          background = value
          backgroundSetAfterShow = shownInactive > 0
        },
        setResizable: () => assert.fail('动画不能切换缩放属性'),
        setMinimumSize() {},
        setHasShadow: () => assert.fail('动画不能切换阴影'),
        setIgnoreMouseEvents(value, options) { ignored = value; assert.equal(options, undefined, '唤回不依赖鼠标转发') },
        isAlwaysOnTop: () => pinned,
        setAlwaysOnTop: value => { pinned = value },
        show() {},
        showInactive() { shownInactive++ },
        focus() { focused++ },
        close() { destroyed = true },
        webContents: { send: (...values) => sent.push(values) },
      }
      if (controls.missingMaterial) delete handle.setBackgroundMaterial
      return handle
    },
  }
  const manager = createWindowManager({
    utools,
    readState: () => saved,
    writeState: value => { saved = value; saves++ },
    readSettings: () => controls.settings,
    onError: value => errors.push(value),
    every(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer },
    stop: timer => timers.delete(timer),
    now: () => clock,
    supportsAcrylic,
    applyWindowsAcrylic,
  })
  return { manager, controls, errors, sent, load: () => load(), tick: () => [...timers].find(timer => timer.delay === 1000)?.callback(),
    advance(ms) { clock += ms; [...timers].filter(timer => timer.delay < 1000).forEach(timer => timer.callback()) },
    view: () => sent.findLast(([channel]) => channel === 'quick-note:window-state')?.[1],
    stats: () => ({ saved, saves, created, focused, shownInactive, handle, windowOptions, material, background, backgroundSetAfterShow, ignored, materialChanges, intervals: [...timers].map(timer => timer.delay) }) }
}

test('加载中的窗口复用同一个就绪结果，显示与激活分开', async () => {
  const fixture = managerFixture()
  const ready = fixture.manager.open()
  assert.equal(fixture.manager.open(), ready)
  assert.equal(fixture.stats().created, 1)
  assert.equal(fixture.stats().focused, 0)
  fixture.load()
  await ready
  assert.equal(fixture.stats().shownInactive, 1)
  assert.equal(fixture.stats().focused, 0)
  fixture.manager.focus()
  assert.equal(fixture.stats().focused, 1)
})

test('关闭后重新创建并恢复位置和置顶状态', async () => {
  const fixture = managerFixture()
  let ready = fixture.manager.open()
  fixture.load()
  await ready
  assert.equal(fixture.manager.isPinned(), true)
  fixture.manager.setPinned(false)
  fixture.stats().handle.setBounds({ x: 200, y: 150, width: 360, height: 600 })
  fixture.manager.close()
  ready = fixture.manager.open()
  fixture.load()
  await ready
  assert.equal(fixture.stats().created, 2)
  assert.deepEqual(fixture.stats().saved, { x: 200, y: 150, width: 360, height: 600, pinned: false, dockEdge: null })
})

test('窗口不移动时不反复写盘；改变位置后保存一次', async () => {
  const fixture = managerFixture()
  const ready = fixture.manager.open()
  fixture.load()
  await ready
  const initial = fixture.stats().saves
  fixture.tick()
  fixture.tick()
  assert.equal(fixture.stats().saves, initial)
  fixture.stats().handle.setBounds({ x: 100, y: 100, width: 340, height: 480 })
  fixture.tick()
  assert.equal(fixture.stats().saves, initial + 1)
})

test('窗口在加载完成前关闭时拒绝就绪结果，旧回调不会重新显示窗口', async () => {
  const fixture = managerFixture()
  const rejected = assert.rejects(fixture.manager.open(), /加载完成前已关闭/)
  fixture.manager.close()
  fixture.load()
  await rejected
  assert.equal(fixture.stats().shownInactive, 0)
  assert.equal(fixture.stats().focused, 0)
})

test('无法显示快贴时关闭失败窗口，允许重新创建', async () => {
  const fixture = managerFixture()
  const rejected = assert.rejects(fixture.manager.open(), /显示失败/)
  fixture.stats().handle.showInactive = () => { throw new Error('显示失败') }
  fixture.load()
  await rejected
  assert.equal(fixture.stats().handle.isDestroyed(), true)
  const ready = fixture.manager.open()
  fixture.load()
  await ready
  assert.equal(fixture.stats().created, 2)
})

async function opened(initial, settings) {
  const f = managerFixture(initial, settings)
  const ready = f.manager.open()
  f.load()
  await ready
  return f
}

test('快贴从透明底创建，首次显示后刷新 Acrylic，忽略旧透明度', async () => {
  const f = await opened({}, { stickyOpacity: 100 })
  const { windowOptions } = f.stats()
  assert.equal(windowOptions.backgroundMaterial, 'acrylic')
  assert.equal(Object.hasOwn(windowOptions, 'opacity'), false)
  assert.equal(windowOptions.resizable, true)
  assert.equal(f.stats().material, 'acrylic')
  assert.equal(f.stats().background, '#00000000')
  assert.equal(f.stats().backgroundSetAfterShow, true)
  f.manager.setInteraction({ inside: true, busy: false, reducedMotion: false })
  f.manager.focus()
  f.manager.setInteraction({ inside: false, busy: false, reducedMotion: false })
  f.tick()
  f.manager.refreshSettings()
  assert.equal(f.stats().material, 'acrylic')
  assert.equal(f.stats().materialChanges, 1)
  assert.equal(f.stats().created, 1)
})

test('系统不支持 Acrylic 时用普通实色窗口', async () => {
  const f = managerFixture({}, {}, false)
  const ready = f.manager.open()
  f.load()
  await ready
  assert.equal(Object.hasOwn(f.stats().windowOptions, 'backgroundMaterial'), false)
  assert.equal(f.stats().windowOptions.backgroundColor, '#F8F9FE')
  assert.equal(f.manager.getAppearance().acrylic, false)
})

test('毛玻璃接口缺失或失败时保留窗口和实色背景，并给出设置说明', async () => {
  for (const mode of ['missingMaterial', 'failMaterial']) {
    const f = managerFixture()
    f.controls[mode] = true
    const ready = f.manager.open()
    f.load()
    await ready
    assert.equal(f.manager.getAppearance().acrylic, false)
    assert.match(f.manager.getAppearance().reason, /实色背景/)
    assert.equal(f.stats().handle.isDestroyed(), false)
    assert.equal(f.stats().background, '#F8F9FE')
    assert.equal(Object.hasOwn(f.stats().windowOptions, 'opacity'), false)
  }
})

test('原生毛玻璃只绑定快贴一次，悬停展开不获取焦点', async () => {
  const titles = []
  const f = managerFixture({ x: 400, y: 0, width: 340, height: 480, dockEdge: 'top' }, { edgeCollapse: true }, true, async title => {
    assert.equal(f.stats().handle.getTitle(), title)
    assert.equal(f.stats().shownInactive, 0)
    assert.match(title, /^quick-note-[a-f0-9]{32}$/)
    titles.push(title)
    return true
  })
  f.controls.missingMaterial = true
  const ready = f.manager.open()
  f.load()
  await ready
  assert.equal(f.stats().handle.getTitle(), f.stats().windowOptions.title)
  assert.deepEqual(f.manager.getAppearance(), { acrylic: true, reason: '' })
  leave(f)
  finish(f)
  assert.equal(f.view().phase, 'collapsed')
  f.controls.cursor = { x: 570, y: 2 }
  f.advance(50)
  finish(f)
  assert.equal(f.view().phase, 'expanded')
  assert.equal(f.stats().focused, 0)
  assert.equal(f.stats().created, 1)
  assert.equal(titles.length, 1)
})

test('找不到快贴句柄时继续使用 Electron 毛玻璃', async () => {
  const f = managerFixture({}, {}, true, async () => false)
  const ready = f.manager.open()
  f.load()
  await ready
  assert.equal(f.stats().handle.getTitle(), f.stats().windowOptions.title)
  assert.equal(f.stats().material, 'acrylic')
  assert.equal(f.stats().background, '#00000000')
  assert.equal(f.manager.getAppearance().acrylic, true)
  assert.match(f.manager.getAppearance().reason, /普通毛玻璃/)
})

test('原生材质初始化期间关闭，旧回调不改变下一扇快贴窗口', async () => {
  let finishFirst
  let calls = 0
  const f = managerFixture({}, {}, true, () => ++calls === 1
    ? new Promise(resolve => { finishFirst = resolve })
    : Promise.resolve(true))
  const closed = assert.rejects(f.manager.open(), /加载完成前已关闭/)
  const firstLoad = f.load()
  f.manager.close()
  await closed
  const ready = f.manager.open()
  f.load()
  await ready
  const current = f.stats().handle
  finishFirst(false)
  await firstLoad
  assert.equal(f.stats().handle, current)
  assert.equal(current.isDestroyed(), false)
  assert.equal(current.getTitle(), f.stats().windowOptions.title)
  assert.equal(f.stats().shownInactive, 1)
  assert.deepEqual(f.manager.getAppearance(), { acrylic: true, reason: '' })
})

test('吸附接受 32 DIP 范围，按最近边判断，等距优先顶部', () => {
  const area = primary.workArea
  const bounds = { x: 32, y: 32, width: 340, height: 480 }
  assert.equal(nearestEdge(bounds, area), 'top')
  assert.equal(nearestEdge({ ...bounds, x: 20 }, area), 'left')
  assert.equal(nearestEdge({ ...bounds, x: 1548, y: 200 }, area), 'right')
  assert.equal(nearestEdge({ ...bounds, x: 1547, y: 200 }, area), null)
  assert.equal(nearestEdge({ ...bounds, x: 500, y: 560 }, area), null)
})

function dock(f, bounds) {
  f.stats().handle.setBounds(bounds)
  f.manager.beginDrag()
  f.manager.endDrag()
}
function leave(f, extra = {}) {
  const bounds = f.stats().handle.getBounds()
  f.controls.cursor = extra.inside ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: 1200, y: 950 }
  f.manager.setInteraction({ inside: false, busy: false, reducedMotion: false, ...extra })
  f.manager.collapse()
}
function finish(f) {
  f.advance(180)
}

test('三边仅移动同一个原生窗口，露出原窗口的 4 DIP 边缘', async () => {
  for (const [edge, bounds, target, hover] of [
    ['top', { x: 400, y: 30, width: 340, height: 480 }, { x: 400, y: -476, width: 340, height: 480 }, { x: 570, y: 2 }],
    ['left', { x: 30, y: 200, width: 340, height: 480 }, { x: -336, y: 200, width: 340, height: 480 }, { x: 2, y: 440 }],
    ['right', { x: 1550, y: 200, width: 340, height: 480 }, { x: 1916, y: 200, width: 340, height: 480 }, { x: 1918, y: 440 }],
  ]) {
    const f = await opened({}, { edgeCollapse: true })
    dock(f, bounds)
    const normal = f.stats().handle.getBounds()
    const materials = f.stats().materialChanges
    leave(f)
    assert.equal(f.view().phase, 'collapsing')
    f.advance(90)
    const middle = f.stats().handle.getBounds()
    assert.equal(middle.width, normal.width)
    assert.equal(middle.height, normal.height)
    assert.equal(middle[edge === 'top' ? 'x' : 'y'], normal[edge === 'top' ? 'x' : 'y'])
    f.tick()
    assert.deepEqual(f.stats().saved, { ...normal, pinned: true, dockEdge: edge })
    finish(f)
    assert.deepEqual(f.stats().handle.getBounds(), target)
    assert.equal(f.stats().material, 'acrylic')
    assert.equal(f.stats().materialChanges, materials)
    assert.equal(f.stats().ignored, true)
    assert.deepEqual(f.stats().intervals, [1000, 50])
    f.controls.cursor = hover
    // 不发送网页鼠标事件或动画帧，直接由原生鼠标位置唤回。
    f.advance(50)
    assert.equal(f.view().phase, 'expanding')
    assert.equal(f.stats().ignored, false)
    finish(f)
    assert.deepEqual(f.stats().handle.getBounds(), normal)
    assert.equal(f.stats().ignored, false)
    assert.equal(f.stats().focused, 0)
    assert.equal(f.stats().created, 1)
    assert.equal(f.stats().materialChanges, materials)
    assert.deepEqual(f.stats().intervals, [1000])
  }
})

test('轮询不触发收起，普通位置和关闭设置不自动停靠', async () => {
  for (const enabled of [true, false]) {
    const f = await opened({ x: 0, y: 200, width: 340, height: 480 }, { edgeCollapse: enabled })
    f.manager.setInteraction({ inside: false, busy: false, reducedMotion: false })
    f.tick(); f.tick(); f.manager.collapse()
    assert.equal(f.view().phase, 'expanded')
    assert.equal(f.view().edge, null)
    if (!enabled) { dock(f, { x: 0, y: 200, width: 340, height: 480 }); assert.equal(f.view().edge, null) }
  }
})

test('顶部和左侧逐帧展开经过零坐标时，不向原生接口传入负零', async () => {
  for (const [edge, bounds, hover] of [
    ['top', { x: 400, y: 0, width: 340, height: 480 }, { x: 570, y: 2 }],
    ['left', { x: 0, y: 200, width: 340, height: 480 }, { x: 2, y: 440 }],
  ]) {
    const f = await opened({}, { edgeCollapse: true })
    dock(f, bounds)
    leave(f)
    for (let elapsed = 0; elapsed < 192; elapsed += 16) f.advance(16)
    assert.equal(f.view().phase, 'collapsed')
    f.controls.cursor = hover
    f.advance(50)
    assert.equal(f.view().phase, 'expanding')
    // 第 144 毫秒会把 -0.476 / -0.336 取整成 -0；旧测试直接跳到终点会漏掉。
    for (let elapsed = 0; elapsed < 160; elapsed += 16) f.advance(16)
    assert.deepEqual(f.errors, [])
    assert.equal(f.view().phase, 'expanded')
    assert.equal(f.view().edge, edge)
    assert.deepEqual(f.stats().handle.getBounds(), bounds)
    assert.equal(f.stats().ignored, false)
    assert.deepEqual(f.stats().intervals, [1000])
  }
})

test('唤回仅命中露出的边缘，展开结束重新核对鼠标，关闭后停止检测', async () => {
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 1580, y: 351, width: 340, height: 480 })
  leave(f)
  finish(f)
  for (const point of [{ x: 1915, y: 600 }, { x: 1918, y: 350 }, { x: 1918, y: 831 }, { x: 1920, y: 600 }]) {
    f.controls.cursor = point
    f.advance(50)
    assert.equal(f.view().phase, 'collapsed')
  }
  f.controls.cursor = { x: 1918, y: 600 }
  f.advance(50)
  assert.equal(f.view().phase, 'expanding')
  f.controls.cursor = { x: 1200, y: 600 }
  finish(f)
  assert.equal(f.view().inside, false)
  assert.deepEqual(f.stats().intervals, [1000])
  leave(f)
  f.manager.close()
  f.advance(1000)
  assert.deepEqual(f.stats().intervals, [])
  assert.equal(f.stats().created, 1)
})

test('草稿、输入法、拖动和鼠标停留均保护窗口，结束后可收起', async () => {
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 0, y: 200, width: 340, height: 480 })
  leave(f, { busy: true })
  assert.equal(f.view().phase, 'expanded')
  leave(f, { inside: true })
  assert.equal(f.view().phase, 'expanded')
  f.manager.beginDrag()
  leave(f)
  assert.equal(f.view().phase, 'expanded')
  f.controls.cursor = { x: 170, y: 440 }
  f.manager.endDrag()
  leave(f)
  assert.equal(f.view().phase, 'collapsing')
})

test('原生移动中无需网页事件即可反向，始终只有一个动画计时器', async () => {
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 0, y: 200, width: 340, height: 480 })
  leave(f)
  f.advance(72)
  const bounds = f.stats().handle.getBounds()
  f.controls.cursor = { x: 2, y: 400 }
  f.advance(16)
  assert.equal(f.view().phase, 'expanding')
  assert.deepEqual(f.stats().intervals, [1000, 16])
  assert.deepEqual(f.stats().handle.getBounds(), bounds)
  finish(f)
  assert.equal(f.view().phase, 'expanded')
  assert.equal(f.stats().focused, 0)
})

test('减少动态效果直接移动，手动唤起和关闭设置都恢复位置及鼠标输入', async () => {
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 400, y: 0, width: 340, height: 480 })
  leave(f, { reducedMotion: true })
  assert.equal(f.view().phase, 'collapsed')
  assert.deepEqual(f.stats().intervals, [1000, 50])
  f.manager.focus()
  assert.equal(f.stats().handle.getBounds().y, 0)
  assert.equal(f.stats().ignored, false)
  assert.equal(f.stats().focused, 1)
  leave(f)
  f.advance(90)
  f.controls.settings.edgeCollapse = false
  f.manager.refreshSettings()
  f.advance(200)
  assert.equal(f.view().edge, null)
  assert.equal(f.view().phase, 'expanded')
  assert.equal(f.stats().handle.getBounds().y, 0)
  assert.equal(f.stats().ignored, false)
  assert.deepEqual(f.stats().intervals, [1000])
})

test('关闭时保存展开位置，重新创建不恢复到屏幕外；拖离后取消停靠', async () => {
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 400, y: 10, width: 340, height: 480 })
  leave(f)
  finish(f)
  f.manager.close()
  assert.deepEqual(f.stats().intervals, [])
  assert.deepEqual(f.stats().saved, { x: 400, y: 0, width: 340, height: 480, pinned: true, dockEdge: 'top' })
  const ready = f.manager.open()
  f.load()
  await ready
  assert.deepEqual(f.stats().handle.getBounds(), { x: 400, y: 0, width: 340, height: 480 })
  f.controls.cursor = { x: 0, y: 0 }
  f.manager.beginDrag()
  f.controls.cursor = { x: 100, y: 200 }
  f.manager.endDrag()
  assert.equal(f.view().edge, null)
  assert.deepEqual(f.stats().handle.getBounds(), { x: 500, y: 200, width: 340, height: 480 })
})

test('负坐标屏幕的外沿可以收起，断开显示器后回到可见区域', async () => {
  const f = await opened({}, { edgeCollapse: true })
  f.controls.displays.push(left)
  dock(f, { x: -1280, y: 100, width: 340, height: 480 })
  leave(f, { reducedMotion: true })
  assert.deepEqual(f.stats().handle.getBounds(), { x: -1616, y: 100, width: 340, height: 480 })
  f.controls.displays = [primary]
  f.sent.length = 0
  f.tick()
  assert.equal(f.sent.filter(([channel]) => channel === 'quick-note:window-state').length, 1)
  assert.deepEqual(f.stats().handle.getBounds(), { x: 0, y: 100, width: 340, height: 480 })
  assert.equal(f.view().edge, null)
  assert.equal(f.stats().ignored, false)
})

test('相邻显示器接缝及任务栏所在边缘不收起，避免窗口露到另一屏或被遮挡', async () => {
  const f = await opened({}, { edgeCollapse: true })
  f.controls.displays.push(left)
  dock(f, { x: -340, y: 100, width: 340, height: 480 })
  assert.equal(f.view().edge, null)
  assert.match(f.errors.at(-1), /其他屏幕/)
  const topTaskbar = { bounds: primary.bounds, workArea: { x: 0, y: 40, width: 1920, height: 1040 } }
  f.controls.displays = [topTaskbar]
  dock(f, { x: 400, y: 40, width: 340, height: 480 })
  assert.equal(f.view().edge, null)
  assert.match(f.errors.at(-1), /任务栏/)
})

test('收起后新增相邻屏幕时立即恢复，旧配置也不再恢复到接缝', async () => {
  const right = { bounds: { x: 1920, y: 0, width: 1280, height: 720 }, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }
  const f = await opened({}, { edgeCollapse: true })
  dock(f, { x: 1580, y: 200, width: 340, height: 480 })
  leave(f, { reducedMotion: true })
  f.controls.displays.push(right)
  f.tick()
  assert.equal(f.view().phase, 'expanded')
  assert.equal(f.view().edge, null)
  assert.equal(f.stats().handle.getBounds().x, 1580)
  assert.equal(f.stats().ignored, false)
  const old = managerFixture({ x: -340, y: 100, width: 340, height: 480, dockEdge: 'right' }, { edgeCollapse: true })
  old.controls.displays.push(left)
  const ready = old.manager.open()
  old.load()
  await ready
  assert.equal(old.view().edge, null)
  assert.equal(old.view().phase, 'expanded')
})

test('系统拒绝移动或限制屏外位置时恢复窗口，停止反复收起', async () => {
  for (const mode of ['failMove', 'clampMove']) {
    const f = await opened({}, { edgeCollapse: true })
    dock(f, { x: 400, y: 0, width: 340, height: 480 })
    leave(f)
    f.controls[mode] = true
    finish(f)
    assert.deepEqual(f.stats().handle.getBounds(), { x: 400, y: 0, width: 340, height: 480 })
    assert.equal(f.view().edge, null)
    assert.equal(f.stats().ignored, false)
    assert.equal(f.stats().saved.y, 0)
    assert.equal(f.errors.length, 1)
    f.manager.collapse()
    assert.equal(f.errors.length, 1)
  }
})

test('拖过右侧边界后仍能识别停靠，鼠标在吸附后落到外侧可正常收起', async () => {
  const f = await opened({}, { edgeCollapse: true })
  f.stats().handle.setBounds({ x: 1760, y: 231, width: 340, height: 480 })
  f.manager.beginDrag(); f.manager.endDrag()
  assert.equal(f.view().edge, 'right')
  assert.equal(f.stats().handle.getBounds().x, 1580)
  dock(f, { x: 1550, y: 200, width: 340, height: 480 })
  f.controls.cursor = { x: 1560, y: 225 }
  f.manager.beginDrag(); f.manager.endDrag()
  assert.equal(f.view().inside, false)
  f.manager.collapse()
  finish(f)
  assert.equal(f.stats().handle.getBounds().x, 1916)
})


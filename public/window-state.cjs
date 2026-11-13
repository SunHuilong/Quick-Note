const { pluginName } = require('./plugin.json')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { setInterval, clearInterval } = require('node:timers')
const { performance } = require('node:perf_hooks')
const DEFAULT_SIZE = { width: 340, height: 480 }
const EDGES = ['top', 'left', 'right']

function sameBounds(a, b) {
  return a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
}

function pointerInside(bounds, point) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
}

function fitBounds(saved, displays, fallback) {
  const areas = displays.map(display => display.workArea)
  const preferred = fallback.workArea
  const hasPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y)
  const area = hasPosition
    ? areas.find(rect => saved.x >= rect.x && saved.x < rect.x + rect.width && saved.y >= rect.y && saved.y < rect.y + rect.height) || preferred
    : preferred
  const width = Math.min(area.width, Math.max(280, Number.isFinite(saved.width) ? saved.width : DEFAULT_SIZE.width))
  const height = Math.min(area.height, Math.max(240, Number.isFinite(saved.height) ? saved.height : DEFAULT_SIZE.height))
  return {
    x: Math.round(Math.max(area.x, Math.min(hasPosition ? saved.x : area.x + area.width - width - 24, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(hasPosition ? saved.y : area.y + 48, area.y + area.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  }
}

function nearestEdge(bounds, area) {
  const distances = [Math.abs(bounds.y - area.y), Math.abs(bounds.x - area.x), Math.abs(bounds.x + bounds.width - area.x - area.width)]
  const distance = Math.min(...distances)
  return distance <= 32 ? EDGES[distances.indexOf(distance)] : null
}

function snap(bounds, area, edge) {
  const result = fitBounds(bounds, [{ workArea: area }], { workArea: area })
  if (edge === 'top') result.y = area.y
  if (edge === 'left') result.x = area.x
  if (edge === 'right') result.x = area.x + area.width - result.width
  return result
}

function hiddenBounds(normal, edge, display) {
  const screen = display.bounds
  if (edge === 'top') return { ...normal, y: screen.y - normal.height + 4 }
  return { ...normal, x: edge === 'left' ? screen.x - normal.width + 4 : screen.x + screen.width - 4 }
}

function canHide(normal, edge, display, displays) {
  if (!edge) return false
  const screen = display.bounds
  const area = display.workArea
  if (edge === 'top' && area.y !== screen.y || edge === 'left' && area.x !== screen.x ||
    edge === 'right' && area.x + area.width !== screen.x + screen.width) return false
  const target = hiddenBounds(normal, edge, display)
  return !displays.some(other => !sameBounds(other.bounds, screen) &&
    target.x < other.bounds.x + other.bounds.width && target.x + target.width > other.bounds.x &&
    target.y < other.bounds.y + other.bounds.height && target.y + target.height > other.bounds.y)
}

function createWindowManager({
  utools, readState, writeState, readSettings, onError, onAppearance = () => {}, applyWindowsAcrylic,
  every = setInterval, stop = clearInterval, now = () => performance.now(),
  supportsAcrylic = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621,
}) {
  let win
  let timer
  let nativeTimer
  let ready
  let rejectOpen
  let settings
  let normal
  let display
  let dockEdge = null
  let phase = 'expanded'
  let motion = null
  let drag = null
  let inside = true
  let busy = false
  let reducedMotion = false
  let appearance = { acrylic: false, reason: supportsAcrylic ? '' : '当前系统不支持毛玻璃，已使用实色背景。' }
  let state = {}
  try { state = readState() } catch { onError('窗口位置读取失败，本次使用默认位置。任务数据不受影响。') }
  let saved = JSON.stringify(state)

  function forgetClosedWindow() {
    win = null
    motion = null
    drag = null
    rejectOpen?.(new Error('快贴在加载完成前已关闭。'))
    rejectOpen = null
    stop(timer)
    stop(nativeTimer)
    timer = null
    nativeTimer = null
  }
  function exists() {
    if (!win) return false
    try {
      if (!win.isDestroyed()) return true
    } catch (error) {
      // uTools 回收窗口 ID 后，连 isDestroyed() 也会抛出 invalid。
      if (error.message !== 'invalid') throw error
    }
    forgetClosedWindow()
    return false
  }
  function send(channel, value) { if (exists()) win.webContents.send(channel, value) }
  function moveTo(x, y) {
    // 取整后加 0 消除负零；Electron 的整数坐标接口会拒绝 -0。
    win.setPosition(Math.round(x) + 0, Math.round(y) + 0)
  }
  function publish() {
    send('quick-note:window-state', { phase, edge: dockEdge, inside })
  }
  function updateNativeLoop() {
    stop(nativeTimer)
    nativeTimer = null
    if (motion || phase === 'collapsed') nativeTimer = every(nativeTick, motion ? 16 : 50)
  }
  function persist() {
    if (!exists()) return
    if (phase === 'expanded' && !drag) normal = win.getBounds()
    state = { ...normal, pinned: win.isAlwaysOnTop(), dockEdge }
    const serialized = JSON.stringify(state)
    if (serialized !== saved) {
      try { writeState(state); saved = serialized }
      catch { onError('窗口状态保存失败，下次可能恢复默认位置。任务数据不受影响。') }
    }
  }
  async function showStickyWindow(created) {
    let nativeApplied = false
    if (supportsAcrylic && applyWindowsAcrylic && typeof created.setTitle === 'function') {
      // uTools 的窗口 ID 不是 HWND。用临时标题定位尚未显示的快贴。
      const title = `quick-note-${randomUUID().replaceAll('-', '')}`
      try {
        created.setTitle(title)
        nativeApplied = await applyWindowsAcrylic(title)
      } catch { /* 原生材质不可用时使用 Electron 的 Acrylic。 */ }
      finally {
        if (created === win && exists()) created.setTitle(pluginName)
      }
    }
    if (created !== win || !exists()) return
    created.showInactive()

    if (supportsAcrylic) {
      try {
        if (!nativeApplied) created.setBackgroundMaterial('acrylic')
        // 显示后设置背景色会触发原生重绘。
        created.setBackgroundColor('#00000000')
        appearance = {
          acrylic: true,
          reason: applyWindowsAcrylic && !nativeApplied ? '系统使用普通毛玻璃，失焦展开时可能显示实色。' : '',
        }
      } catch {
        try { created.setBackgroundColor('#F8F9FE') } catch { /* 页面会绘制实色背景。 */ }
        appearance = { acrylic: false, reason: '毛玻璃不可用，已使用实色背景。' }
      }
    }
    onAppearance(appearance)
    send('quick-note:appearance', appearance)
  }
  function restore() {
    motion = null
    win.setIgnoreMouseEvents(false)
    const currentDisplay = utools.getDisplayMatching(normal)
    if (!sameBounds(display.workArea, currentDisplay.workArea) || !canHide(normal, dockEdge, currentDisplay, utools.getAllDisplays())) dockEdge = null
    normal = fitBounds(normal, utools.getAllDisplays(), currentDisplay)
    display = currentDisplay
    phase = 'expanded'
    updateNativeLoop()
    win.setBounds(normal)
    win.setMinimumSize(Math.min(280, display.workArea.width), Math.min(240, display.workArea.height))
    publish()
  }
  function recover(error) {
    dockEdge = null
    try { restore(); persist() } finally { onError(`快贴窗口调整失败，已保持展开：${error.message || '请重新拖动快贴。'}`) }
  }
  function finishMotion() {
    const collapsing = phase === 'collapsing'
    const target = motion.to
    moveTo(target.x, target.y)
    const actual = win.getBounds()
    if (Math.abs(actual.x - target.x) > 1 || Math.abs(actual.y - target.y) > 1) throw new Error('系统未允许移动到目标位置。')
    motion = null
    phase = collapsing ? 'collapsed' : 'expanded'
    inside = pointerInside(actual, utools.getCursorScreenPoint())
    updateNativeLoop()
    publish()
    persist()
  }
  function transition(collapsing) {
    if (!exists() || rejectOpen || !dockEdge) return
    if (collapsing && (phase !== 'expanded' || inside || busy || drag || !settings.edgeCollapse)) return
    if (!collapsing && (phase === 'expanded' || phase === 'expanding')) return
    if (collapsing && pointerInside(win.getBounds(), utools.getCursorScreenPoint())) {
      inside = true
      publish()
      return
    }
    try {
      if (phase === 'expanded') {
        display = utools.getDisplayMatching(win.getBounds())
        normal = snap(win.getBounds(), display.workArea, dockEdge)
        if (!canHide(normal, dockEdge, display, utools.getAllDisplays())) {
          dockEdge = null
          restore()
          persist()
          return
        }
        moveTo(normal.x, normal.y)
      }
      const from = win.getBounds()
      phase = collapsing ? 'collapsing' : 'expanding'
      motion = { from, to: collapsing ? hiddenBounds(normal, dockEdge, display) : normal, duration: collapsing ? 180 : 160, started: now() }
      // 收起时避免拖到原生缩放边缘；唤回直接检测屏幕鼠标，不依赖网页事件。
      win.setIgnoreMouseEvents(collapsing)
      if (reducedMotion) finishMotion()
      else { updateNativeLoop(); publish() }
    } catch (error) { recover(error) }
  }
  function nativeTick() {
    if (!exists()) return
    try {
      if (phase === 'collapsed' || phase === 'collapsing') {
        const point = utools.getCursorScreenPoint()
        if (pointerInside(display.bounds, point) && pointerInside(win.getBounds(), point)) {
          inside = true
          transition(false)
        }
      }
      if (!motion) return
      const progress = Math.max(0, Math.min(1, (now() - motion.started) / motion.duration))
      const eased = 1 - (1 - progress) ** 3
      const x = motion.from.x + (motion.to.x - motion.from.x) * eased
      const y = motion.from.y + (motion.to.y - motion.from.y) * eased
      if (progress === 1) finishMotion()
      else moveTo(x, y)
    } catch (error) { recover(error) }
  }
  function setInteraction(value) {
    if (!value || ['inside', 'busy', 'reducedMotion'].some(key => typeof value[key] !== 'boolean')) return
    inside = value.inside && (!exists() || pointerInside(win.getBounds(), utools.getCursorScreenPoint()))
    busy = value.busy
    reducedMotion = value.reducedMotion
    if (inside || busy) transition(false)
    if (reducedMotion && motion) {
      try { finishMotion() } catch (error) { recover(error) }
    }
  }
  function refreshSettings() {
    settings = readSettings()
    if (!exists() || rejectOpen) return
    if (!settings.edgeCollapse && dockEdge) {
      dockEdge = null
      restore()
      persist()
    }
  }
  function focus() {
    if (!exists()) throw new Error('快贴已关闭，请重新打开。')
    inside = true
    if (phase === 'expanded') normal = win.getBounds()
    restore()
    win.show()
    win.focus()
    send('quick-note:activate')
  }
  function beginDrag() {
    if (!exists() || rejectOpen) return
    if (phase !== 'expanded') restore()
    normal = win.getBounds()
    drag = { bounds: normal, cursor: utools.getCursorScreenPoint() }
    inside = true
  }
  function moveDrag() {
    if (!drag || !exists()) return
    const point = utools.getCursorScreenPoint()
    moveTo(drag.bounds.x + point.x - drag.cursor.x, drag.bounds.y + point.y - drag.cursor.y)
  }
  function endDrag() {
    if (!drag || !exists()) return
    try {
      moveDrag()
      const bounds = win.getBounds()
      display = utools.getDisplayMatching(bounds)
      const fitted = fitBounds(bounds, [display], display)
      dockEdge = settings.edgeCollapse ? nearestEdge(fitted, display.workArea) : null
      if (dockEdge && !canHide(fitted, dockEdge, display, utools.getAllDisplays())) {
        dockEdge = null
        onError('这条边缘连接其他屏幕或被任务栏占用，快贴保持展开。')
      }
      normal = snap(fitted, display.workArea, dockEdge)
      win.setBounds(normal)
      inside = pointerInside(win.getBounds(), utools.getCursorScreenPoint())
    } finally { drag = null }
    publish()
    persist()
  }
  function tick() {
    if (!exists() || rejectOpen || drag) return
    try {
      const current = utools.getDisplayMatching(normal)
      if (!sameBounds(current.workArea, display.workArea) || !sameBounds(current.bounds, display.bounds) ||
        dockEdge && !canHide(normal, dockEdge, current, utools.getAllDisplays())) {
        dockEdge = null
        restore()
      } else if (phase === 'expanded' && !sameBounds(normal, win.getBounds())) {
        normal = win.getBounds()
        display = utools.getDisplayMatching(normal)
        if (dockEdge && nearestEdge(normal, display.workArea) !== dockEdge) dockEdge = null
        publish()
      }
      persist()
    } catch (error) { onError(`窗口位置保存失败：${error.message || '请重新打开快贴。'}`) }
  }
  function open() {
    if (exists()) return ready
    settings = readSettings()
    phase = 'expanded'
    inside = true
    busy = false
    ready = new Promise((resolve, reject) => {
      rejectOpen = reject
      const preferred = utools.getDisplayNearestPoint(utools.getCursorScreenPoint())
      normal = fitBounds(state, utools.getAllDisplays(), preferred)
      display = utools.getDisplayMatching(normal)
      dockEdge = settings.edgeCollapse && EDGES.includes(state.dockEdge) && normal.x === state.x && normal.y === state.y ? state.dockEdge : null
      if (dockEdge && !canHide(normal, dockEdge, display, utools.getAllDisplays())) dockEdge = null
      if (dockEdge) normal = snap(normal, display.workArea, dockEdge)
      const pinned = state.pinned !== false
      const created = utools.createBrowserWindow('index.html?view=sticky', {
        ...normal, title: pluginName, show: false, frame: false, resizable: true, movable: true,
        minWidth: Math.min(280, display.workArea.width), minHeight: Math.min(240, display.workArea.height),
        maximizable: false, minimizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: pinned,
        backgroundColor: supportsAcrylic ? '#00000000' : '#F8F9FE',
        // Electron 在创建窗口时根据材质选择合成模式。
        ...(supportsAcrylic ? { backgroundMaterial: 'acrylic' } : {}),
        webPreferences: { preload: 'preload.js' },
      }, async () => {
        if (created !== win) return
        try {
          if (!exists()) return
          publish()
          await showStickyWindow(created)
          if (created !== win || !exists()) return
          send('quick-note:pinned', pinned)
          persist()
          rejectOpen = null
          resolve()
        } catch (error) {
          reject(error)
          if (created === win && exists()) {
            created.close()
            forgetClosedWindow()
          }
        }
      })
      win = created
      // 屏外窗口可能收不到网页事件或绘制帧，唤回与动画使用 Node 计时器。
      timer = every(tick, 1000)
    })
    return ready
  }

  return {
    open, focus, send, refreshSettings, setInteraction, beginDrag, moveDrag, endDrag,
    collapse: () => transition(true),
    getAppearance: () => appearance,
    isPinned: () => exists() ? win.isAlwaysOnTop() : state.pinned !== false,
    setPinned(value) {
      if (typeof value !== 'boolean' || !exists()) return
      win.setAlwaysOnTop(value)
      persist()
      send('quick-note:pinned', value)
    },
    close() {
      persist()
      if (!win) return
      win.close()
      forgetClosedWindow()
    },
  }
}

module.exports = { fitBounds, nearestEdge, createWindowManager }

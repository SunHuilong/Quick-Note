// 仅由浏览器自检注入；不会进入 dist，也不接触 uTools 的真实数据。
export function installBrowserHost(seed) {
  const key = 'quick-note-browser-test'
  const changes = new Set()
  const pins = new Set()
  const windows = new Set()
  const appearances = new Set()
  const errors = new Set()
  let pinned = true
  let windowState = { phase: 'expanded', edge: null }
  let appearance = { acrylic: true, reason: '' }
  let animationTimer
  function publishWindow(value) {
    windowState = { ...windowState, ...value }
    windows.forEach(callback => callback(windowState))
  }
  function animate(phase) {
    clearTimeout(animationTimer)
    const end = phase === 'collapsing' ? 'collapsed' : 'expanded'
    if (window.testHost.interaction?.reducedMotion) publishWindow({ phase: end })
    else {
      publishWindow({ phase })
      // 这里只模拟宿主状态通知，原生位置与计时器由 window.test.mjs 验证。
      animationTimer = setTimeout(() => publishWindow({ phase: end }), phase === 'collapsing' ? 180 : 160)
    }
  }
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ docs: seed, settings: null, revision: 1000 }))
  const read = () => JSON.parse(localStorage.getItem(key))
  const write = value => localStorage.setItem(key, JSON.stringify(value))
  const copy = value => structuredClone(value)
  window.testHost = {
    failNext: false,
    failSettingsNext: false,
    reportError: message => errors.forEach(callback => callback(message)),
    getState: read,
    reset(docs) { write({ docs, settings: null, revision: 2000 }); changes.forEach(callback => callback()) },
    notify: () => changes.forEach(callback => callback()),
    windowEvents: [],
    taskReads: 0,
    interaction: null,
    dock(edge) { clearTimeout(animationTimer); publishWindow({ edge, phase: 'expanded' }) },
    collapse(edge) { clearTimeout(animationTimer); publishWindow({ edge, phase: 'collapsed' }) },
    setAppearance(value) { appearance = value; appearances.forEach(callback => callback(value)) },
  }
  window.utools = {
    db: {
      get: id => copy(read().docs.find(doc => doc._id === id) || null),
      allDocs(prefix) { window.testHost.taskReads++; return copy(read().docs.filter(doc => doc._id.startsWith(prefix))) },
      put(doc) {
        if (window.testHost.failNext) { window.testHost.failNext = false; return { error: true, message: '测试：保存失败' } }
        const state = read()
        const index = state.docs.findIndex(record => record._id === doc._id)
        if ((index < 0 ? undefined : state.docs[index]._rev) !== doc._rev) return { error: true, name: 'conflict' }
        const result = { ...copy(doc), _rev: `${++state.revision}-test` }
        if (index < 0) state.docs.push(result)
        else state.docs[index] = result
        write(state)
        return { ok: true, id: doc._id, rev: result._rev }
      },
      remove(doc) {
        const state = read()
        const current = state.docs.find(record => record._id === doc._id)
        if (current?._rev !== doc._rev) return { error: true, name: 'conflict' }
        state.docs = state.docs.filter(record => record._id !== doc._id)
        write(state)
        return { ok: true }
      },
    },
    dbStorage: {
      getItem: () => copy(read().settings),
      setItem(key, value) {
        if (window.testHost.failSettingsNext) { window.testHost.failSettingsNext = false; throw new Error('测试：设置保存失败') }
        const state = read(); state.settings = copy(value); write(state)
      },
    },
  }
  window.quickNote = {
    notifyDataChanged: () => changes.forEach(callback => callback()),
    onDataChanged(callback) { changes.add(callback); return () => changes.delete(callback) },
    onActivate: () => () => {},
    onError(callback) { errors.add(callback); return () => errors.delete(callback) },
    onPinnedChanged(callback) { pins.add(callback); return () => pins.delete(callback) },
    onWindowState(callback) { windows.add(callback); return () => windows.delete(callback) },
    getWindowState: () => windowState,
    onAppearance(callback) { appearances.add(callback); return () => appearances.delete(callback) },
    getAppearance: () => appearance,
    setStickyInteraction(value) {
      window.testHost.interaction = value
      windowState = { ...windowState, inside: value.inside }
      if ((value.inside || value.busy) && ['collapsed', 'collapsing'].includes(windowState.phase)) animate('expanding')
    },
    collapseSticky() { window.testHost.windowEvents.push({ event: 'collapse', time: performance.now() }); animate('collapsing') },
    beginStickyDrag() { window.testHost.windowEvents.push({ event: 'drag-start' }) },
    moveStickyDrag() { window.testHost.windowEvents.push({ event: 'drag-move' }) },
    endStickyDrag() {
      window.testHost.windowEvents.push({ event: 'drag-end' })
      publishWindow({ inside: window.testHost.dragEndInside !== false })
    },
    isPinned: () => pinned,
    setPinned(value) { pinned = value; pins.forEach(callback => callback(value)) },
    openSticky() { window.testHost.openedSticky = true },
    openTimeline() { window.testHost.openedTimeline = true },
    closeSticky() { window.testHost.closedSticky = true },
  }
  window.addEventListener('storage', event => { if (event.key === key) changes.forEach(callback => callback()) })
}

export function exampleTasks() {
  function item(id, text, daysAgo, hour, completed = false) {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    date.setHours(hour, 0, 0, 0)
    return {
      _id: `quick-note/task/${id}`,
      _rev: '1-test',
      text,
      createdAt: date.getTime(),
      createdDay: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      completedAt: completed ? Math.min(date.getTime(), Date.now() - 6000) : null,
    }
  }
  return [
    item('a', '确认导出表格里的日期格式', 0, 8),
    item('b', '把刚才想到的小优化记下来\n输入框保留上一次的草稿', 0, 9),
    item('c', '回看昨天的接口联调记录', 0, 10, true),
    item('d', '补充两个边界场景的说明', 1, 9),
    item('e', '整理桌面上临时保存的截图', 1, 10, true),
    item('f', '试一下新的日志查询方式', 2, 11),
    item('g', '把需要反馈的问题列出来', 2, 14, true),
  ]
}

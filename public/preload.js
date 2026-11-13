const { ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createWindowManager } = require('./window-state.cjs')
const { createRepository } = require('./repository.cjs')
const { registerTaskTools } = require('./mcp-tools.cjs')
const config = require('./plugin.json')
const sticky = new URLSearchParams(window.location.search).get('view') === 'sticky'
const callbacks = { changed: new Set(), activate: new Set(), error: new Set(), pinned: new Set(), windowState: new Set(), appearance: new Set() }
let pendingActivation = false
let pendingError = ''
let pinned = true
let windowState = { phase: 'expanded', edge: null }
let appearance = { acrylic: false, reason: '' }
let hasEntered = false
let launchSequence = 0
let manager

function emit(event, value) {
  if (event === 'activate' && !callbacks.activate.size) pendingActivation = true
  if (event === 'error' && !callbacks.error.size) pendingError = value
  for (const listener of callbacks[event]) listener(value)
}

function subscribe(event, listener) {
  callbacks[event].add(listener)
  if (event === 'activate' && pendingActivation) { pendingActivation = false; listener() }
  if (event === 'error' && pendingError) { const error = pendingError; pendingError = ''; listener(error) }
  return () => callbacks[event].delete(listener)
}

function report(error) {
  const message = typeof error === 'string' ? error : `窗口操作失败：${error.message || '请重试。'}`
  emit('error', message)
  if (!sticky) manager?.send('quick-note:error', message)
}

const localFile = path.join(utools.getPluginLocalDataPath(), 'window.json')
function readState() {
  if (!fs.existsSync(localFile)) return {}
  const state = JSON.parse(fs.readFileSync(localFile, 'utf8'))
  return state && typeof state === 'object' ? state : {}
}
function writeState(state) {
  fs.mkdirSync(path.dirname(localFile), { recursive: true })
  fs.writeFileSync(`${localFile}.tmp`, JSON.stringify(state), 'utf8')
  fs.renameSync(`${localFile}.tmp`, localFile)
}

const repository = createRepository(utools)
if (!sticky) manager = createWindowManager({
  utools, readState, writeState, readSettings: repository.getSettings, onError: report,
  onAppearance: value => emit('appearance', value),
  applyWindowsAcrylic: require('./windows-acrylic.cjs').applyWindowsAcrylic,
})
if (sticky) {
  try { pinned = readState().pinned !== false } catch { /* 父窗口会报告配置读取错误。 */ }
}

function refreshData() {
  emit('changed')
  if (!sticky) {
    try { manager.refreshSettings() } catch (error) { report(error) }
  }
}

function changed() {
  refreshData()
  try {
    if (sticky) utools.sendToParent('quick-note:changed')
    else manager.send('quick-note:changed')
  } catch {
    emit('error', '记录已保存，但另一窗口暂未刷新。重新打开窗口可读取最新内容。')
  }
}

function activateMain() {
  utools.showMainWindow()
  emit('activate')
}

async function openSticky(request, onlySticky = false) {
  try {
    await manager.open()
    // 快贴加载期间再次进入主界面时，旧请求不得抢回焦点或隐藏主窗。
    if (request !== launchSequence) return
    manager.focus()
    if (onlySticky) utools.hideMainWindow(false)
  } catch (error) {
    if (request !== launchSequence) return
    activateMain()
    report(error)
  }
}

function closeSticky() {
  launchSequence++
  manager.close()
}

ipcRenderer.on('quick-note:changed', refreshData)
if (sticky) {
  ipcRenderer.on('quick-note:activate', () => emit('activate'))
  ipcRenderer.on('quick-note:error', (_, message) => emit('error', message))
  ipcRenderer.on('quick-note:pinned', (_, value) => { pinned = value; emit('pinned', value) })
  ipcRenderer.on('quick-note:window-state', (_, value) => { windowState = value; emit('windowState', value) })
  ipcRenderer.on('quick-note:appearance', (_, value) => { appearance = value; emit('appearance', value) })
} else {
  registerTaskTools(utools, repository, config.tools, {
    onUse: () => { hasEntered = true },
    onChange: changed,
  })
  ipcRenderer.on('quick-note:pin', (_, value) => {
    try { manager.setPinned(value) } catch (error) { report(error) }
  })
  ipcRenderer.on('quick-note:close', () => {
    try { closeSticky() } catch (error) { report(error) }
  })
  ipcRenderer.on('quick-note:interaction', (_, value) => manager.setInteraction(value))
  for (const [channel, action] of [['collapse', 'collapse'], ['drag-start', 'beginDrag'], ['drag-move', 'moveDrag'], ['drag-end', 'endDrag']]) {
    ipcRenderer.on(`quick-note:${channel}`, () => {
      try { manager[action]() } catch (error) { report(error) }
    })
  }
  utools.onPluginEnter(({ code }) => {
    const request = ++launchSequence
    const coldStart = !hasEntered
    hasEntered = true
    try {
      if (code === 'sticky') return openSticky(request)
      if (code === 'home' && coldStart && utools.dbStorage.getItem('quick-note/settings')?.autoOpenSticky === true) {
        return openSticky(request, true)
      }
      activateMain()
    } catch (error) {
      activateMain()
      report(error)
    }
  })
  utools.onDbPull(() => changed())
}

window.quickNote = {
  notifyDataChanged: changed,
  onDataChanged: listener => subscribe('changed', listener),
  onActivate: listener => subscribe('activate', listener),
  onError: listener => subscribe('error', listener),
  onPinnedChanged: listener => subscribe('pinned', listener),
  onWindowState: listener => subscribe('windowState', listener),
  getWindowState: () => windowState,
  onAppearance: listener => subscribe('appearance', listener),
  getAppearance: () => sticky ? appearance : manager.getAppearance(),
  setStickyInteraction(value) { if (sticky) utools.sendToParent('quick-note:interaction', value) },
  collapseSticky() { if (sticky) utools.sendToParent('quick-note:collapse') },
  beginStickyDrag() { if (sticky) utools.sendToParent('quick-note:drag-start') },
  moveStickyDrag() { if (sticky) utools.sendToParent('quick-note:drag-move') },
  endStickyDrag() { if (sticky) utools.sendToParent('quick-note:drag-end') },
  isPinned: () => sticky ? pinned : manager.isPinned(),
  openSticky() {
    if (!sticky) return openSticky(++launchSequence)
  },
  openTimeline() {
    utools.redirect('快记时间线')
  },
  setPinned(value) {
    if (sticky) utools.sendToParent('quick-note:pin', value)
    else manager.setPinned(value)
  },
  closeSticky() {
    if (sticky) utools.sendToParent('quick-note:close')
    else closeSticky()
  },
}

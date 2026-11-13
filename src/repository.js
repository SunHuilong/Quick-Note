import { localDay } from './domain.js'

export const TASK_PREFIX = 'quick-note/task/'
export const SETTINGS_KEY = 'quick-note/settings'

function cleanText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('先写点内容再保存。')
  return text.trim()
}

function checkResult(result) {
  if (result?.ok) return result
  if (result?.name === 'conflict' || result?.status === 409) {
    throw Object.assign(new Error('任务已在其他窗口或设备更新，请核对最新内容。'), { code: 'conflict' })
  }
  throw new Error(`保存失败，内容已保留。${result?.message || '请稍后重试。'}`)
}

export function createRepository(utools, { now = Date.now, uuid = () => crypto.randomUUID() } = {}) {
  function currentTask(task) {
    if (!task?._id?.startsWith(TASK_PREFIX) || !task._rev) throw new Error('任务标识无效，请重新打开。')
    const current = utools.db.get(task._id)
    if (!current) throw Object.assign(new Error('这条任务已被删除，你的编辑内容仍保留在此处。'), { code: 'missing' })
    if (current._rev !== task._rev) {
      throw Object.assign(new Error('任务已在其他窗口或设备更新，请核对最新内容。'), { code: 'conflict', latest: current })
    }
    return current
  }

  function update(task, patch) {
    const doc = { ...currentTask(task), ...patch }
    try {
      const result = checkResult(utools.db.put(doc))
      return { ...doc, _rev: result.rev }
    } catch (error) {
      if (error.code === 'conflict') error.latest = utools.db.get(task._id)
      throw error
    }
  }

  return {
    list: () => utools.db.allDocs(TASK_PREFIX),
    get(id) {
      if (typeof id !== 'string' || !id.startsWith(TASK_PREFIX) || id.length === TASK_PREFIX.length) throw new Error('任务 ID 无效。')
      const task = utools.db.get(id)
      if (!task) throw Object.assign(new Error('任务不存在或已被删除。'), { code: 'missing' })
      return task
    },
    create(text) {
      const timestamp = now()
      const task = {
        _id: `${TASK_PREFIX}${uuid()}`,
        text: cleanText(text),
        createdAt: timestamp,
        createdDay: localDay(timestamp),
        completedAt: null,
      }
      const result = checkResult(utools.db.put(task))
      return { ...task, _rev: result.rev }
    },
    edit: (task, text) => update(task, { text: cleanText(text) }),
    setCompleted: (task, completed) => update(task, { completedAt: completed ? now() : null }),
    remove(task) {
      checkResult(utools.db.remove(currentTask(task)))
    },
    getSettings() {
      const settings = utools.dbStorage.getItem(SETTINGS_KEY)
      return {
        showCompleted: settings?.showCompleted !== false,
        autoOpenSticky: settings?.autoOpenSticky === true,
        edgeCollapse: settings?.edgeCollapse === true,
      }
    },
    saveSettings(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置无效。')
      const entries = Object.entries(patch)
      if (!entries.length || entries.some(([key, value]) =>
        !['showCompleted', 'autoOpenSticky', 'edgeCollapse'].includes(key) || typeof value !== 'boolean')) {
        throw new Error('设置无效。')
      }
      const current = utools.dbStorage.getItem(SETTINGS_KEY)
      utools.dbStorage.setItem(SETTINGS_KEY, { ...current, ...patch })
      const saved = utools.dbStorage.getItem(SETTINGS_KEY)
      if (entries.some(([key, value]) => saved?.[key] !== value)) {
        throw new Error('设置没有保存成功，请重试。')
      }
    },
  }
}

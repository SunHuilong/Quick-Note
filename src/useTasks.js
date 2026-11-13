import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { localDay, nextClockDelay, visibleOnSticky } from './domain.js'
import { createRepository } from './repository.js'

export function useTasks(sticky) {
  const repository = createRepository(window.utools)
  const bridge = window.quickNote
  const tasks = ref([])
  const showCompleted = ref(true)
  const autoOpenSticky = ref(false)
  const edgeCollapse = ref(false)
  const now = ref(Date.now())
  const error = ref('')
  const loaded = ref(false)
  const editing = reactive(new Map())
  let clock
  let unsubscribe
  let unsubscribeError

  const today = computed(() => localDay(now.value))
  const displayTasks = computed(() => {
    const result = tasks.value.filter(task => !sticky || editing.has(task._id) || visibleOnSticky(task, showCompleted.value, now.value))
    const present = new Set(result.map(task => task._id))
    for (const [id, snapshot] of editing) {
      if (!present.has(id)) result.push(snapshot)
    }
    return result
  })

  function scheduleClock() {
    clearTimeout(clock)
    clock = setTimeout(() => {
      now.value = Date.now()
    }, nextClockDelay(tasks.value, !sticky || showCompleted.value, now.value))
  }

  function refresh() {
    try {
      const records = repository.list()
      const settings = repository.getSettings()
      tasks.value = records
      showCompleted.value = settings.showCompleted
      autoOpenSticky.value = settings.autoOpenSticky
      edgeCollapse.value = settings.edgeCollapse
      loaded.value = true
      now.value = Date.now()
      if (error.value === '读取失败，当前内容已保留。请重试。') error.value = ''
    } catch {
      error.value = '读取失败，当前内容已保留。请重试。'
    }
  }

  function change(operation) {
    const result = operation()
    bridge.notifyDataChanged()
    return result
  }

  watch([tasks, showCompleted, now], scheduleClock, { flush: 'post' })
  onMounted(() => {
    unsubscribe = bridge.onDataChanged(refresh)
    unsubscribeError = bridge.onError(message => { error.value = message })
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
  })
  function onVisibility() {
    if (!document.hidden) refresh()
  }
  onUnmounted(() => {
    clearTimeout(clock)
    unsubscribe?.()
    unsubscribeError?.()
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return {
    tasks, displayTasks, showCompleted, autoOpenSticky, edgeCollapse, now, today, error, loaded, editing, refresh,
    create: text => change(() => repository.create(text)),
    edit: (task, text) => change(() => repository.edit(task, text)),
    setCompleted: (task, completed) => change(() => repository.setCompleted(task, completed)),
    remove: task => change(() => repository.remove(task)),
    saveSettings: patch => change(() => repository.saveSettings(patch)),
    setEditing(task, active) {
      if (active) editing.set(task._id, { ...task })
      else editing.delete(task._id)
    },
  }
}

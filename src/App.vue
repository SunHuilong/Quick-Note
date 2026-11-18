<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import TaskComposer from './components/TaskComposer.vue'
import TaskRow from './components/TaskRow.vue'
import { dayDetail, dayLabel, groupTasks } from './domain.js'
import { useTasks } from './useTasks.js'
import { useStickyWindow } from './useStickyWindow.js'

const supported = Boolean(window.utools?.db && window.quickNote)
const bridge = window.quickNote
const logo = `${import.meta.env.BASE_URL}logo.png`
const sticky = new URLSearchParams(window.location.search).get('view') === 'sticky'
const state = supported ? useTasks(sticky) : null
const { tasks, displayTasks, showCompleted, autoOpenSticky, edgeCollapse, now, today, error, loaded } = state || {}
const groups = computed(() => supported ? groupTasks(displayTasks.value, today.value, !sticky) : [])
const hasHistory = computed(() => groups.value.some(group => group.day !== today.value))
const pending = computed(() => supported ? tasks.value.filter(task => task.completedAt === null).length : 0)
const completedDaysCollapsed = ref(false)
const completedDaysButton = ref(null)
const collapsibleDays = computed(() => {
  const days = new Set()
  for (const { day, tasks } of groups.value) {
    if (day === today.value) continue
    if (tasks.length && tasks.every(task => task.completedAt !== null && !state.editing.has(task._id))) days.add(day)
  }
  return days
})
const timelineGroups = computed(() => completedDaysCollapsed.value
  ? groups.value.filter(group => !collapsibleDays.value.has(group.day))
  : groups.value)
const completedDaysAction = computed(() => completedDaysCollapsed.value ? '展开已完成的历史日期' : '收起已完成的历史日期')
const composer = ref(null)
const settingsDialog = ref(null)
const settingsButton = ref(null)
const preferences = reactive({ showCompleted: true, autoOpenSticky: false, edgeCollapse: false })
const preferenceError = ref('')
const pinned = ref(supported ? window.quickNote.isPinned() : true)
const composerHasDraft = ref(false)
const stickyWindow = supported && sticky ? useStickyWindow(computed(() => composerHasDraft.value || state.editing.size > 0)) : null
const appearance = ref(supported ? bridge.getAppearance() : { acrylic: false, reason: '' })
const scrollbarTimers = new Map()
let unsubscribeActivate
let unsubscribePinned
let unsubscribeAppearance

if (sticky && supported) watch(appearance, value => document.documentElement.classList.toggle('acrylic-window', value.acrylic), { immediate: true })
if (!sticky && supported) watch(timelineGroups, () => {
  if (!completedDaysCollapsed.value) return
  // 在 Vue 移除日期列前转移其中的键盘焦点。
  const focusedDay = document.activeElement?.closest('.day-column')?.dataset.day
  if (collapsibleDays.value.has(focusedDay)) completedDaysButton.value?.focus({ preventScroll: true })
})

function showScrollbar({ target }) {
  target.toggleAttribute('data-scrolling', true)
  clearTimeout(scrollbarTimers.get(target))
  scrollbarTimers.set(target, setTimeout(() => {
    target.removeAttribute('data-scrolling')
    scrollbarTimers.delete(target)
  }, 600))
}

function syncPreferences() {
  Object.assign(preferences, { showCompleted: showCompleted.value, autoOpenSticky: autoOpenSticky.value, edgeCollapse: edgeCollapse.value })
}

function windowAction(action) {
  error.value = ''
  try { action() } catch (failure) { error.value = failure.message || '窗口操作失败，请重试。' }
}
async function savePreference(key) {
  try {
    state.saveSettings({ [key]: preferences[key] })
    preferenceError.value = ''
  } catch (failure) {
    // 先完成本次 v-model 更新，再回滚原生勾选状态。
    await nextTick()
    syncPreferences()
    preferenceError.value = failure.message || '设置保存失败，请重试。'
  }
}
function openSettings() { preferenceError.value = ''; settingsDialog.value.showModal() }
if (supported) watch([showCompleted, autoOpenSticky, edgeCollapse], syncPreferences, { immediate: true })

onMounted(async () => {
  if (!supported) return
  unsubscribeActivate = window.quickNote.onActivate(async () => {
    state.refresh()
    await nextTick()
    if (!state.editing.size && !settingsDialog.value?.open) composer.value?.focus()
  })
  unsubscribePinned = window.quickNote.onPinnedChanged(value => { pinned.value = value })
  unsubscribeAppearance = bridge.onAppearance(value => { appearance.value = value })
  await nextTick()
  composer.value?.focus()
})
onUnmounted(() => {
  unsubscribeActivate?.()
  unsubscribePinned?.()
  unsubscribeAppearance?.()
  for (const timer of scrollbarTimers.values()) clearTimeout(timer)
  scrollbarTimers.clear()
  document.documentElement.classList.remove('acrylic-window')
})
</script>

<template>
  <main v-if="!supported" class="unsupported"><img class="unsupported-logo" :src="logo" alt="" /><h1>快记 · Quick note</h1><p>请在 uTools 开发者工具中导入构建目录里的 plugin.json，再使用「快记」或「快记时间线」打开。</p><small>此页面不会在浏览器中保存任务。</small></main>
  <main v-else class="app" :class="sticky ? 'sticky-app' : 'timeline-app'" @scroll.capture.passive="showScrollbar">
    <header v-if="sticky" class="sticky-header" @pointerdown="stickyWindow.beginDrag" @pointermove="stickyWindow.moveDrag" @pointerup="stickyWindow.endDrag" @pointercancel="stickyWindow.endDrag" @lostpointercapture="stickyWindow.endDrag">
      <div class="sticky-brand"><img class="brand-mark" :src="logo" alt="" draggable="false" /><h1>快记</h1></div>
      <nav class="window-actions" aria-label="快贴窗口操作">
        <button class="icon-button" :class="{ active: pinned }" :aria-pressed="pinned" :aria-label="pinned ? '取消置顶' : '置顶窗口'" :title="pinned ? '取消置顶' : '置顶窗口'" @click="windowAction(() => bridge.setPinned(!pinned))"><Icon name="pin" /></button>
        <button class="icon-button" aria-label="打开时间线" title="打开时间线" @click="windowAction(() => bridge.openTimeline())"><Icon name="board" /></button>
        <button class="icon-button close-button" aria-label="关闭快贴" title="关闭快贴" @click="windowAction(() => bridge.closeSticky())"><Icon name="close" /></button>
      </nav>
    </header>
    <header v-else class="main-header">
      <div class="main-heading"><img class="brand-mark" :src="logo" alt="" draggable="false" /><div><h1>快记 <span class="english-name">· Quick note</span></h1><p>随手记一笔，做完勾一下。</p></div></div>
      <nav class="main-actions" aria-label="界面操作"><button class="secondary-button" @click="windowAction(() => bridge.openSticky())"><Icon name="note" /><span>打开快贴</span></button><button ref="settingsButton" class="icon-button settings-button" aria-label="设置" title="设置" @click="openSettings"><Icon name="settings" /></button></nav>
    </header>

    <TaskComposer ref="composer" :create="state.create" :disabled="!loaded" @draft-change="composerHasDraft = $event" />
    <div v-if="error" class="global-error" role="alert"><span>{{ error }}</span><button class="text-action" @click="error = ''; state.refresh()">重试</button></div>

    <div v-if="sticky" class="sticky-list" :class="{ 'with-timeline': hasHistory }" aria-label="快贴任务列表">
      <section v-for="group in groups" :key="group.day" class="sticky-day" :aria-label="dayLabel(group.day, now)">
        <h2 v-if="hasHistory" class="day-heading"><span>{{ dayLabel(group.day, now) }}</span><small>{{ dayDetail(group.day) }}</small></h2>
        <TaskRow v-for="task in group.tasks" :key="task._id" :task="task" :actions="state" :hide-completed="!showCompleted" :now="now" />
      </section>
      <div v-if="loaded && !groups.length" class="empty-state"><span class="empty-symbol"><Icon name="check" /></span><p>{{ tasks.length ? '眼前的事，都完成了' : '有件小事？先记下来' }}</p><small>{{ tasks.length ? '完成记录留在时间线里。' : '不必分类，写下就好。' }}</small></div>
    </div>
    <div v-else id="timeline-board" class="timeline-board" aria-label="按日期排列的任务">
      <section v-for="group in timelineGroups" :key="group.day" class="day-column" :class="{ 'today-column': group.day === today }" :data-day="group.day" :aria-label="dayLabel(group.day, now)">
        <header class="column-header"><div><h2>{{ dayLabel(group.day, now) }}<span v-if="group.day === today" class="today-dot"></span></h2><p>{{ dayDetail(group.day) }}</p></div><span class="task-count" :aria-label="`${group.tasks.length} 条记录`">{{ group.tasks.length }}</span></header>
        <div class="column-list"><TaskRow v-for="task in group.tasks" :key="task._id" :task="task" :actions="state" :now="now" /><div v-if="!group.tasks.length" class="column-empty"><Icon name="plus" /><p>今天，留一点空白</p><small>新记录会出现在这里。</small></div></div>
      </section>
    </div>

    <footer class="app-footer">
      <span><span class="status-dot"></span>{{ pending ? `${pending} 项待办` : '暂无待办' }}</span>
      <button
        v-if="!sticky"
        ref="completedDaysButton"
        type="button"
        class="icon-button"
        :class="{ active: completedDaysCollapsed }"
        :disabled="!completedDaysCollapsed && !collapsibleDays.size"
        :aria-label="completedDaysAction"
        :title="completedDaysAction"
        :aria-expanded="!completedDaysCollapsed"
        aria-controls="timeline-board"
        @click="completedDaysCollapsed = !completedDaysCollapsed"
      ><Icon :name="completedDaysCollapsed ? 'expand' : 'collapse'" /></button>
    </footer>

    <dialog v-if="!sticky" ref="settingsDialog" class="settings-dialog" aria-labelledby="settings-title" @close="settingsButton?.focus()">
      <header><h2 id="settings-title">快记设置</h2><button class="icon-button" aria-label="关闭设置" @click="settingsDialog.close()"><Icon name="close" /></button></header>
      <fieldset><legend>启动方式</legend><label class="setting-option"><span><strong>启动时自动打开快贴</strong><small id="startup-hint">开启后，插件重新启动时只显示快贴；运行中再次打开仍显示主界面。更改不影响当前窗口。</small></span><input v-model="preferences.autoOpenSticky" class="setting-switch" type="checkbox" role="switch" name="autoOpenSticky" aria-label="启动时自动打开快贴" aria-describedby="startup-hint" @change="savePreference('autoOpenSticky')" /></label></fieldset>
      <fieldset>
        <legend>快贴窗口</legend>
        <label class="setting-option"><span><strong>贴边自动收起</strong><small id="edge-hint">拖近顶部或左右外沿自动吸附，移出收起、悬停展开；输入时保持展开，显示器接缝不收起。</small></span><input v-model="preferences.edgeCollapse" class="setting-switch" type="checkbox" role="switch" name="edgeCollapse" aria-label="贴边自动收起" aria-describedby="edge-hint" @change="savePreference('edgeCollapse')" /></label>
        <p v-if="appearance.reason" class="setting-hint" role="status">{{ appearance.reason }}</p>
      </fieldset>
      <fieldset><legend>快贴中的已完成任务</legend><label class="preference-option"><input v-model="preferences.showCompleted" type="radio" name="completed" :value="true" @change="savePreference('showCompleted')" /><span><strong>划线常显</strong><small>保留在原位，随时再次勾选恢复。</small></span></label><label class="preference-option"><input v-model="preferences.showCompleted" type="radio" name="completed" :value="false" @change="savePreference('showCompleted')" /><span><strong>完成后隐藏</strong><small>划线保留 5 秒，期间可再次勾选恢复。</small></span></label></fieldset>
      <p class="settings-note">此设置仅适用于桌面快贴。主界面右下角的双箭头可收起或展开任务全部完成的历史日期列。今天的日期列始终显示。</p><p v-if="preferenceError" class="inline-error" role="alert">{{ preferenceError }}</p>
    </dialog>
  </main>
</template>

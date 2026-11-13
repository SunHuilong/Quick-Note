<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { HIDE_DELAY, submitsText } from '../domain.js'
import Icon from './Icon.vue'

const props = defineProps({ task: { type: Object, required: true }, actions: { type: Object, required: true }, hideCompleted: Boolean, now: Number })
const editing = ref(false)
const draft = ref('')
const original = ref(null)
const editor = ref(null)
const textButton = ref(null)
const menu = ref(false)
const confirming = ref(false)
const error = ref('')
const conflict = ref(null)
let composing = false
let saveAfterComposition = false
const completed = computed(() => props.task.completedAt !== null)
const pendingHide = computed(() => props.hideCompleted && completed.value && props.task.completedAt + HIDE_DELAY > props.now)

async function beginEdit() {
  original.value = { ...props.task }
  draft.value = props.task.text
  error.value = ''
  conflict.value = null
  menu.value = false
  editing.value = true
  composing = false
  saveAfterComposition = false
  window.addEventListener('blur', blur)
  document.addEventListener('pointerdown', outsideEditor, true)
  props.actions.setEditing(props.task, true)
  await nextTick()
  editor.value.focus()
  resizeEditor()
}
function resizeEditor() {
  if (!editor.value) return
  editor.value.style.height = 'auto'
  editor.value.style.height = `${Math.min(240, editor.value.scrollHeight)}px`
}
async function finishEdit(restoreFocus = true) {
  editing.value = false
  saveAfterComposition = false
  window.removeEventListener('blur', blur)
  document.removeEventListener('pointerdown', outsideEditor, true)
  error.value = ''
  conflict.value = null
  props.actions.setEditing(props.task, false)
  if (restoreFocus) {
    await nextTick()
    textButton.value?.focus()
  }
}
function save(restoreFocus = true) {
  if (!editing.value || conflict.value) return
  try {
    if (draft.value.trim() !== original.value.text) props.actions.edit(original.value, draft.value)
    finishEdit(restoreFocus)
  } catch (failure) {
    error.value = failure.message || '保存失败，草稿已保留。'
    conflict.value = failure.latest || null
    props.actions.refresh()
  }
}
function blur() {
  if (!editing.value) return
  if (composing) saveAfterComposition = true
  else save(false)
}
function outsideEditor(event) {
  if (!editor.value?.contains(event.target)) blur()
}
function compositionStart() { composing = true }
async function compositionEnd() {
  composing = false
  if (!saveAfterComposition) return
  saveAfterComposition = false
  await nextTick()
  save(false)
}
function acceptLatest() {
  original.value = { ...conflict.value }
  conflict.value = null
  error.value = ''
  editor.value.focus()
}
function keydown(event) {
  if (event.isComposing || event.keyCode === 229) return
  if (submitsText(event)) { event.preventDefault(); save() }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit() }
}
async function toggle(event) {
  try {
    props.actions.setCompleted(props.task, event.target.checked)
    error.value = ''
  } catch (failure) {
    error.value = failure.message
    props.actions.refresh()
  }
  await nextTick()
  event.target.checked = completed.value
}
function remove() {
  try { props.actions.remove(props.task) }
  catch (failure) { error.value = failure.message; props.actions.refresh() }
  confirming.value = false
  menu.value = false
}
onUnmounted(() => {
  window.removeEventListener('blur', blur)
  document.removeEventListener('pointerdown', outsideEditor, true)
})
</script>

<template>
  <article class="task-row" :class="{ completed }" :data-task-id="task._id">
    <div class="task-line">
      <input class="task-checkbox" type="checkbox" :checked="completed" :disabled="editing || confirming" :aria-label="`${completed ? '恢复' : '完成'}任务：${task.text}`" @change="toggle" />
      <div class="task-content">
        <textarea v-if="editing" ref="editor" v-model="draft" class="task-editor" aria-label="编辑任务内容，Enter 或离开编辑框保存，Esc 取消" rows="1" @input="resizeEditor" @keydown="keydown" @blur="blur" @compositionstart="compositionStart" @compositionend="compositionEnd" />
        <button v-else ref="textButton" class="task-text" :title="'点击编辑'" @click="beginEdit">{{ task.text }}</button>
        <small v-if="pendingHide && !editing" class="hide-hint">即将隐藏，取消勾选可恢复</small>
      </div>
      <button v-if="!editing" class="icon-button task-more" :aria-label="`任务操作：${task.text}`" :aria-expanded="menu" title="任务操作" @click="menu = !menu; confirming = false"><Icon name="more" /></button>
    </div>
    <div v-if="menu && !confirming" class="row-actions"><button class="text-action" @click="beginEdit">编辑</button><button class="text-action danger" @click="confirming = true">删除</button><button class="text-action" @click="menu = false">收起</button></div>
    <div v-if="confirming" class="delete-confirm" role="group" aria-label="确认删除任务"><span>删除这条记录？</span><button class="text-action danger" @click="remove">确认删除</button><button class="text-action" @click="confirming = false; menu = false">取消</button></div>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <div v-if="editing && conflict" class="conflict-box">
      <small>最新内容 · {{ conflict.completedAt === null ? '未完成' : '已完成' }}</small>
      <p>{{ conflict.text }}</p>
      <button class="text-action" @click="acceptLatest">已核对，保留草稿继续编辑</button>
    </div>
  </article>
</template>

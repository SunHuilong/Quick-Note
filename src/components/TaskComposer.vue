<script setup>
import { nextTick, ref, watch } from 'vue'
import { submitsText } from '../domain.js'
import Icon from './Icon.vue'

const props = defineProps({ create: { type: Function, required: true }, disabled: Boolean })
const text = ref('')
const error = ref('')
const input = ref(null)
const emit = defineEmits(['draft-change'])
watch(text, value => emit('draft-change', value.length > 0), { flush: 'sync' })

function resize() {
  error.value = ''
  input.value.style.height = 'auto'
  input.value.style.height = `${Math.min(116, input.value.scrollHeight)}px`
}
async function submit() {
  if (props.disabled || !text.value.trim()) return
  try {
    props.create(text.value)
    text.value = ''
    error.value = ''
    await nextTick()
    resize()
    input.value.focus()
  } catch (failure) {
    error.value = failure.message || '保存失败，内容已保留。请重试。'
  }
}
function keydown(event) {
  if (submitsText(event)) { event.preventDefault(); submit() }
}
defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="composer-wrap">
    <form class="composer" aria-label="新增待办" @submit.prevent="submit">
      <textarea ref="input" v-model="text" rows="1" aria-label="记下要做的事" placeholder="记下要做的事…" :disabled="disabled" @input="resize" @keydown="keydown" />
      <button class="add-button" type="submit" :disabled="disabled || !text.trim()" aria-label="添加待办" title="添加待办（Enter）"><Icon name="plus" /></button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p class="input-hint">Enter 记下 <span>·</span> Shift + Enter 换行</p>
  </div>
</template>

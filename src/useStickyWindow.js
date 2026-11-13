import { onMounted, onUnmounted, ref, watch } from 'vue'

export function useStickyWindow(busy) {
  const bridge = window.quickNote
  const state = ref(bridge.getWindowState())
  const inside = ref(true)
  const composing = ref(false)
  const dragging = ref(false)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let collapseTimer
  let moveFrame
  let dragTarget
  let pointerId
  let unsubscribe

  function scheduleCollapse() {
    clearTimeout(collapseTimer)
    if (!inside.value && !busy.value && !composing.value && !dragging.value && state.value.edge && state.value.phase === 'expanded') {
      collapseTimer = setTimeout(() => bridge.collapseSticky(), 120)
    }
  }
  function syncInteraction() {
    bridge.setStickyInteraction({ inside: inside.value, busy: busy.value || composing.value, reducedMotion: reduced.matches })
    scheduleCollapse()
  }
  function receive(value) {
    state.value = value
    if (typeof value.inside === 'boolean') inside.value = value.inside
    scheduleCollapse()
  }
  function enter() { inside.value = true }
  function leave() { inside.value = false }
  function compositionStart() { composing.value = true }
  function compositionEnd() { composing.value = false }

  function beginDrag(event) {
    if (event.button !== 0 || event.target.closest('button, input, textarea, a') || dragging.value) return
    event.preventDefault()
    dragTarget = event.currentTarget
    pointerId = event.pointerId
    dragTarget.setPointerCapture(pointerId)
    dragging.value = true
    inside.value = true
    bridge.beginStickyDrag()
  }
  function moveDrag(event) {
    if (!dragging.value || event.pointerId !== pointerId || moveFrame) return
    moveFrame = requestAnimationFrame(() => { moveFrame = null; bridge.moveStickyDrag() })
  }
  function endDrag(event) {
    if (!dragging.value || event.pointerId !== pointerId) return
    cancelAnimationFrame(moveFrame)
    moveFrame = null
    dragging.value = false
    if (dragTarget.hasPointerCapture(pointerId)) dragTarget.releasePointerCapture(pointerId)
    bridge.endStickyDrag()
    scheduleCollapse()
  }

  watch([inside, busy, composing, dragging], syncInteraction, { flush: 'sync' })
  onMounted(() => {
    unsubscribe = bridge.onWindowState(receive)
    receive(bridge.getWindowState())
    syncInteraction()
    document.documentElement.addEventListener('pointerenter', enter)
    document.documentElement.addEventListener('pointerleave', leave)
    document.addEventListener('compositionstart', compositionStart, true)
    document.addEventListener('compositionend', compositionEnd, true)
    reduced.addEventListener('change', syncInteraction)
  })
  onUnmounted(() => {
    clearTimeout(collapseTimer)
    cancelAnimationFrame(moveFrame)
    unsubscribe?.()
    document.documentElement.removeEventListener('pointerenter', enter)
    document.documentElement.removeEventListener('pointerleave', leave)
    document.removeEventListener('compositionstart', compositionStart, true)
    document.removeEventListener('compositionend', compositionEnd, true)
    reduced.removeEventListener('change', syncInteraction)
  })
  return { beginDrag, moveDrag, endDrag }
}

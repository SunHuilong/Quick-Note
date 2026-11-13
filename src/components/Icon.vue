<script setup>
defineProps({ name: { type: String, required: true } })
const paths = {
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  pin: 'm16 3 5 5-4 1-4 4-1 4-5-5 4-1 4-4 1-4ZM7 17l-4 4',
  board: 'M4 4h16v16H4zM9 4v16m6-16v16',
  collapse: 'M12 4v16M3 12h6M6 9l3 3-3 3M21 12h-6M18 9l-3 3 3 3',
  expand: 'M12 4v16M9 12H3M6 9l-3 3 3 3M15 12h6M18 9l3 3-3 3',
  note: 'M5 3h14v14l-4 4H5V3Zm9 18v-6h5M8 7h8M8 11h5',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  check: 'm5 12 4 4L19 6',
}
</script>

<template>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="name === 'more' ? 3.5 : 1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>

export const HIDE_DELAY = 5000

export function localDay(value = Date.now()) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dayLabel(day, now = Date.now()) {
  if (day === localDay(now)) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === localDay(yesterday)) return '昨天'
  const [year, month, date] = day.split('-')
  return `${year === String(new Date(now).getFullYear()) ? '' : `${year} 年 `}${Number(month)} 月 ${Number(date)} 日`
}

export function dayDetail(day) {
  const [year, month, date] = day.split('-').map(Number)
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(year, month - 1, date))
  return `${String(month).padStart(2, '0')}.${String(date).padStart(2, '0')} · ${weekday}`
}

export function groupTasks(tasks, today, includeToday = false) {
  const groups = new Map(includeToday ? [[today, []]] : [])
  for (const task of tasks) {
    if (!groups.has(task.createdDay)) groups.set(task.createdDay, [])
    groups.get(task.createdDay).push(task)
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([day, items]) => ({
    day,
    tasks: items.sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id)),
  }))
}

export function visibleOnSticky(task, showCompleted, now) {
  return showCompleted || task.completedAt === null || task.completedAt + HIDE_DELAY > now
}

export function nextClockDelay(tasks, showCompleted, now) {
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  let next = midnight.getTime()
  if (!showCompleted) {
    for (const task of tasks) {
      if (task.completedAt !== null && task.completedAt + HIDE_DELAY > now) {
        next = Math.min(next, task.completedAt + HIDE_DELAY)
      }
    }
  }
  return Math.max(1, next - now)
}

export function submitsText(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229
}

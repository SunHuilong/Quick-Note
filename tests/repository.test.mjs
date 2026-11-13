import test from 'node:test'
import assert from 'node:assert/strict'
import { createRepository, SETTINGS_KEY } from '../src/repository.js'
import { localDay, dayLabel, groupTasks, visibleOnSticky, nextClockDelay, submitsText } from '../src/domain.js'

function fixture() {
  const docs = new Map()
  let revision = 0
  let time = new Date(2026, 10, 11, 23, 59, 58).getTime()
  let sequence = 0
  const host = {
    db: {
      get: id => structuredClone(docs.get(id) || null),
      allDocs: prefix => structuredClone([...docs].filter(([id]) => id.startsWith(prefix)).map(([, doc]) => doc)),
      put(doc) {
        if (docs.get(doc._id)?._rev !== doc._rev) return { error: true, name: 'conflict' }
        const rev = `${++revision}-test`
        docs.set(doc._id, structuredClone({ ...doc, _rev: rev }))
        return { ok: true, id: doc._id, rev }
      },
      remove(doc) {
        if (docs.get(doc._id)?._rev !== doc._rev) return { error: true, name: 'conflict' }
        docs.delete(doc._id)
        return { ok: true }
      },
    },
    dbStorage: {
      getItem: key => structuredClone(docs.get(key) || null),
      setItem: (key, value) => docs.set(key, structuredClone(value)),
    },
  }
  const options = { now: () => time, uuid: () => String(++sequence) }
  return { host, docs, repo: createRepository(host, options), other: createRepository(host, options), setTime: value => { time = value } }
}

test('跨日编辑和完成保留创建日期；新记录使用当天日期', () => {
  const { repo, setTime } = fixture()
  const first = repo.create('  昨天的任务\n第二行  ')
  assert.equal(first.createdDay, '2026-11-11')
  assert.equal(first.text, '昨天的任务\n第二行')
  const today = new Date(2026, 10, 12, 8).getTime()
  setTime(today)
  const changed = repo.edit(first, '修改历史任务')
  const completed = repo.setCompleted(changed, true)
  assert.equal(completed.createdDay, '2026-11-11')
  assert.equal(completed.createdAt, first.createdAt)
  assert.equal(completed.completedAt, today)
  assert.equal(repo.create('今天新建').createdDay, '2026-11-12')
  assert.equal(repo.setCompleted(completed, false).completedAt, null)
})

test('空白内容不保存；每条任务单独存储，设置不混入列表', () => {
  const { repo, docs } = fixture()
  assert.throws(() => repo.create(' \n '), /写点内容/)
  const task = repo.create('第一条')
  assert.throws(() => repo.edit(task, ''), /写点内容/)
  repo.create('第二条')
  repo.saveSettings({ showCompleted: false })
  assert.equal(repo.list().length, 2)
  assert.equal(docs.size, 3)
  assert.deepEqual(repo.getSettings(), { showCompleted: false, autoOpenSticky: false, edgeCollapse: false })
  assert.ok(docs.has(SETTINGS_KEY))
})

test('两个窗口编辑同一记录时保留已提交版本，显式核对后才允许再保存', () => {
  const { repo, other } = fixture()
  const original = repo.create('原始内容')
  const latest = other.edit(original, '另一个窗口的修改')
  assert.throws(() => repo.edit(original, '未提交草稿'), error => error.code === 'conflict' && error.latest.text === latest.text)
  assert.equal(repo.list()[0].text, latest.text)
  const reviewed = repo.edit(latest, '核对后提交的草稿')
  assert.equal(reviewed.text, '核对后提交的草稿')
})

test('完成与删除也检查版本；已经删除的记录不复活', () => {
  const { repo, other } = fixture()
  const original = repo.create('任务')
  const latest = other.setCompleted(original, true)
  assert.throws(() => repo.remove(original), { code: 'conflict' })
  assert.throws(() => repo.setCompleted(original, false), { code: 'conflict' })
  repo.remove(latest)
  assert.throws(() => repo.edit(latest, '旧草稿'), { code: 'missing' })
  assert.deepEqual(repo.list(), [])
})

test('数据库写入失败不会报告成功，也不修改原始快照', () => {
  const { repo, host } = fixture()
  const task = repo.create('原文')
  host.db.put = () => ({ error: true, message: '磁盘已满' })
  assert.throws(() => repo.edit(task, '草稿'), /磁盘已满/)
  assert.equal(task.text, '原文')
  assert.equal(repo.list()[0].text, '原文')
  assert.throws(() => repo.create('未保存'), /保存失败/)
})

test('读取后写入前发生冲突时，也返回数据库中的最新内容', () => {
  const { repo, host, docs } = fixture()
  const task = repo.create('旧内容')
  host.db.put = () => {
    docs.set(task._id, { ...task, text: '同时写入的内容', _rev: '99-test' })
    return { error: true, name: 'conflict' }
  }
  assert.throws(() => repo.edit(task, '草稿'), error => error.code === 'conflict' && error.latest.text === '同时写入的内容')
})

test('显示偏好默认常显，写入失败可检测', () => {
  const { repo, host } = fixture()
  assert.deepEqual(repo.getSettings(), { showCompleted: true, autoOpenSticky: false, edgeCollapse: false })
  host.dbStorage.setItem = () => {}
  assert.throws(() => repo.saveSettings({ showCompleted: false }), /没有保存成功/)
})

test('旧设置默认不自动启动快贴，两个选项交错保存时互不覆盖', () => {
  const { repo, other, host } = fixture()
  host.dbStorage.setItem(SETTINGS_KEY, { showCompleted: false })
  assert.deepEqual(repo.getSettings(), { showCompleted: false, autoOpenSticky: false, edgeCollapse: false })
  other.saveSettings({ autoOpenSticky: true })
  assert.deepEqual(repo.getSettings(), { showCompleted: false, autoOpenSticky: true, edgeCollapse: false })
  repo.saveSettings({ showCompleted: true })
  assert.deepEqual(other.getSettings(), { showCompleted: true, autoOpenSticky: true, edgeCollapse: false })
  other.saveSettings({ autoOpenSticky: false })
  assert.deepEqual(repo.getSettings(), { showCompleted: true, autoOpenSticky: false, edgeCollapse: false })
})

test('旧透明度设置不影响快贴，其他偏好仍可独立保存', () => {
  const { repo, other, host } = fixture()
  host.dbStorage.setItem(SETTINGS_KEY, { stickyOpacity: 100 })
  repo.saveSettings({ autoOpenSticky: true })
  repo.saveSettings({ edgeCollapse: true })
  other.saveSettings({ showCompleted: false })
  assert.deepEqual(repo.getSettings(), { showCompleted: false, autoOpenSticky: true, edgeCollapse: true })
})

test('设置只接受有效字段与取值，拒绝旧接口和错误字段', () => {
  const { repo, docs } = fixture()
  for (const invalid of [false, null, [], {}, { autoOpenSticky: 'true' }, { unknown: true }, { edgeCollapse: 1 }, { stickyOpacity: 96 }]) {
    assert.throws(() => repo.saveSettings(invalid), /设置无效/)
  }
  assert.equal(docs.size, 0)
})

test('完成项在 5 秒边界隐藏，撤销后一直可见', () => {
  const task = { completedAt: 1000 }
  assert.equal(visibleOnSticky(task, false, 5999), true)
  assert.equal(visibleOnSticky(task, false, 6000), false)
  assert.equal(visibleOnSticky(task, true, 99999), true)
  assert.equal(visibleOnSticky({ completedAt: null }, false, 99999), true)
})

test('日期倒序、日内正序，完成状态不参与排序，今天可以为空', () => {
  const items = [
    { _id: 'later', createdAt: 20, createdDay: '2026-11-11', completedAt: null },
    { _id: 'early', createdAt: 10, createdDay: '2026-11-11', completedAt: 25 },
    { _id: 'old', createdAt: 1, createdDay: '2026-11-09', completedAt: null },
  ]
  const groups = groupTasks(items, '2026-11-12', true)
  assert.deepEqual(groups.map(group => group.day), ['2026-11-12', '2026-11-11', '2026-11-09'])
  assert.deepEqual(groups[1].tasks.map(task => task._id), ['early', 'later'])
  assert.deepEqual(groupTasks([], '2026-11-12'), [])
})

test('本地日期、月末和跨年标签，以及午夜时钟', () => {
  const now = new Date(2027, 0, 1, 0, 0, 1).getTime()
  assert.equal(localDay(new Date(2026, 10, 12, 0, 1)), '2026-11-12')
  assert.equal(dayLabel('2027-01-01', now), '今天')
  assert.equal(dayLabel('2026-12-31', now), '昨天')
  assert.equal(dayLabel('2026-12-30', now), '2026 年 12 月 30 日')
  assert.equal(nextClockDelay([], true, new Date(2026, 10, 12, 23, 59, 58).getTime()), 2000)
  assert.equal(nextClockDelay([{ completedAt: now - 1000 }], false, now), 4000)
})

test('中文输入法和 Shift+Enter 不提交', () => {
  assert.equal(submitsText({ key: 'Enter' }), true)
  assert.equal(submitsText({ key: 'Enter', shiftKey: true }), false)
  assert.equal(submitsText({ key: 'Enter', isComposing: true }), false)
  assert.equal(submitsText({ key: 'Enter', keyCode: 229 }), false)
})

test('1,000 条跨 90 天记录不丢失，分组结果完整', () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => {
    const createdAt = new Date(2026, 7, 15 + index % 90, 9, 0, index).getTime()
    return { _id: `item-${index}`, createdAt, createdDay: localDay(createdAt), completedAt: index % 2 ? null : createdAt }
  })
  const groups = groupTasks(tasks, '2026-11-12', true)
  assert.equal(groups.flatMap(group => group.tasks).length, 1000)
  assert.equal(groups.length, 90)
})

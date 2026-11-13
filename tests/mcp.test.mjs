import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRepository, TASK_PREFIX } from '../src/repository.js'

const require = createRequire(import.meta.url)
const { registerTaskTools } = require('../public/mcp-tools.cjs')
const { tools: schemas } = require('../public/plugin.json')

function fixture() {
  const docs = new Map()
  const handlers = new Map()
  let revision = 0
  let sequence = 0
  let time = new Date(2026, 10, 12, 10).getTime()
  let changes = 0
  let uses = 0
  const utools = {
    registerTool: (name, handler) => handlers.set(name, handler),
    db: {
      get: id => structuredClone(docs.get(id) || null),
      allDocs: prefix => structuredClone([...docs.values()].filter(doc => doc._id.startsWith(prefix))),
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
  }
  const repo = createRepository(utools, { now: () => time, uuid: () => String(++sequence) })
  registerTaskTools(utools, repo, schemas, { onUse: () => uses++, onChange: () => changes++ })
  return {
    repo, docs, handlers,
    call: (name, params) => handlers.get(name)(params),
    setTime: value => { time = value },
    stats: () => ({ changes, uses }),
  }
}

const identity = task => ({ task_id: task._id, expected_revision: task._rev })

test('MCP 声明的六项能力全部注册，新增与读取返回 JSON 任务和最新版本', () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()].sort(), Object.keys(schemas).sort())
  const result = f.call('create_task', { text: '  随手记\n第二行  ' })
  assert.equal(result.task.text, '随手记\n第二行')
  assert.equal(result.task.createdDay, '2026-11-12')
  assert.equal(result.task.completedAt, null)
  assert.deepEqual(f.call('get_task', { task_id: result.task._id }), result)
  assert.doesNotThrow(() => JSON.stringify(result))
  assert.deepEqual(f.stats(), { changes: 1, uses: 2 })
})

test('日期、状态、关键词筛选及分页与界面时间线一致', () => {
  const f = fixture()
  f.setTime(new Date(2026, 10, 11, 10).getTime())
  const older = f.call('create_task', { text: '昨天的 TODO' }).task
  f.setTime(new Date(2026, 10, 12, 9).getTime())
  const first = f.call('create_task', { text: '今天的 todo 第一条' }).task
  f.setTime(new Date(2026, 10, 12, 10).getTime())
  const second = f.call('create_task', { text: '今天的另一条记录' }).task
  f.call('set_task_completed', { ...identity(older), completed: true })
  const pending = f.call('list_tasks', { status: 'pending', created_from: '2026-11-12', created_to: '2026-11-12', keyword: 'TODO' })
  assert.deepEqual(pending.tasks.map(task => task._id), [first._id])
  const page = f.call('list_tasks', { limit: 1 })
  assert.equal(page.total, 3)
  assert.equal(page.next_offset, 1)
  assert.equal(page.tasks[0]._id, first._id)
  const rest = f.call('list_tasks', { offset: page.next_offset, limit: 2 })
  assert.deepEqual(rest.tasks.map(task => task._id), [second._id, older._id])
  assert.equal(rest.next_offset, null)
  const completed = f.call('list_tasks', { status: 'completed' })
  assert.equal(completed.tasks[0].createdDay, '2026-11-11')
})

test('查询默认有界，可继续读取剩余记录，读取不产生变更通知', () => {
  const f = fixture()
  for (let index = 0; index < 55; index++) f.repo.create(`任务 ${index}`)
  const first = f.call('list_tasks', {})
  assert.equal(first.tasks.length, 50)
  assert.equal(first.total, 55)
  assert.equal(first.next_offset, 50)
  assert.equal(f.call('list_tasks', { offset: 50 }).tasks.length, 5)
  assert.equal(f.stats().changes, 0)
})

test('修改复用任务规则，保留创建日和完成状态', () => {
  const f = fixture()
  f.setTime(new Date(2026, 10, 11, 10).getTime())
  const original = f.call('create_task', { text: '昨天的任务' }).task
  const completed = f.call('set_task_completed', { ...identity(original), completed: true }).task
  f.setTime(new Date(2026, 10, 12, 11).getTime())
  const updated = f.call('update_task', { ...identity(completed), text: '修改后的内容' }).task
  assert.equal(updated.createdDay, '2026-11-11')
  assert.equal(updated.createdAt, original.createdAt)
  assert.equal(updated.completedAt, completed.completedAt)
  assert.notEqual(updated._rev, completed._rev)
})

test('完成操作设置明确目标，重复完成不改时间或版本，恢复可撤销', () => {
  const f = fixture()
  const original = f.call('create_task', { text: '完成与恢复' }).task
  const completed = f.call('set_task_completed', { ...identity(original), completed: true }).task
  f.setTime(new Date(2026, 10, 13, 10).getTime())
  const repeated = f.call('set_task_completed', { ...identity(completed), completed: true }).task
  assert.equal(repeated.completedAt, completed.completedAt)
  assert.equal(repeated._rev, completed._rev)
  assert.equal(f.call('set_task_completed', { ...identity(repeated), completed: false }).task.completedAt, null)
})

test('所有修改和删除都拒绝过期版本，保留另一窗口的修改', () => {
  const f = fixture()
  const original = f.repo.create('原始内容')
  const newer = f.repo.edit(original, '另一窗口已保存')
  assert.throws(() => f.call('update_task', { ...identity(original), text: '旧草稿' }), /版本已变化/)
  assert.throws(() => f.call('set_task_completed', { ...identity(original), completed: true }), /版本已变化/)
  assert.throws(() => f.call('delete_task', { ...identity(original), confirm: true }), /版本已变化/)
  assert.deepEqual(f.repo.get(newer._id), newer)
  assert.equal(f.stats().changes, 0)
})

test('删除必须显式确认且只作用于指定任务', () => {
  const f = fixture()
  const remove = f.repo.create('要删除的记录')
  const keep = f.repo.create('必须保留的记录')
  assert.throws(() => f.call('delete_task', identity(remove)), /明确确认/)
  assert.throws(() => f.call('delete_task', { ...identity(remove), confirm: false }), /明确确认/)
  assert.equal(f.docs.size, 2)
  assert.deepEqual(f.call('delete_task', { ...identity(remove), confirm: true }), { deleted: true, task_id: remove._id })
  assert.equal(f.docs.size, 1)
  assert.deepEqual(f.repo.get(keep._id), keep)
  assert.throws(() => f.call('get_task', { task_id: remove._id }), /不存在/)
})

test('输入边界拒绝错误日期、无效过滤条件、未知字段和非任务 ID', () => {
  const f = fixture()
  for (const invalid of [
    { created_from: '2026-02-30' }, { created_to: '2026/11/12' },
    { created_from: '2026-11-12', created_to: '2026-11-11' },
    { status: 'unknown' }, { keyword: 123 }, { limit: 201 }, { limit: 0 }, { limit: 1.5 }, { offset: -1 },
  ]) assert.throws(() => f.call('list_tasks', invalid))
  assert.throws(() => f.call('create_task', { text: '   ' }), /写点内容/)
  assert.throws(() => f.call('create_task', { text: '任务', createdDay: '2026-01-01' }), /未支持的参数/)
  assert.throws(() => f.call('get_task', { task_id: 'quick-note/settings' }), /ID 无效/)
  assert.throws(() => f.call('get_task', { task_id: TASK_PREFIX }), /ID 无效/)
  for (const invalid of [null, [], 'string']) assert.throws(() => f.call('list_tasks', invalid), /JSON 对象/)
  assert.equal(f.docs.size, 0)
})

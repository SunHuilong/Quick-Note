function registerTaskTools(utools, repository, schemas, { onUse, onChange }) {
  function record(params) {
    if (typeof params.expected_revision !== 'string' || !params.expected_revision) throw new Error('请先读取任务，并提供最新的 expected_revision。')
    const task = repository.get(params.task_id)
    if (task._rev !== params.expected_revision) throw new Error('任务版本已变化，请重新读取并核对后再操作。')
    return task
  }

  function day(value, name) {
    if (value === undefined) return
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} 必须是 YYYY-MM-DD 日期。`)
    const parsed = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${name} 不是有效日期。`)
  }

  const handlers = {
    list_tasks(params) {
      const { created_from, created_to, keyword = '', status = 'all', offset = 0, limit = 50 } = params
      day(created_from, 'created_from')
      day(created_to, 'created_to')
      if (created_from && created_to && created_from > created_to) throw new Error('开始日期不能晚于结束日期。')
      if (typeof keyword !== 'string') throw new Error('keyword 必须是字符串。')
      if (!['all', 'pending', 'completed'].includes(status)) throw new Error('status 必须是 all、pending 或 completed。')
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数。')
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须是 1 到 200 的整数。')
      const query = keyword.trim().toLocaleLowerCase()
      const tasks = repository.list().filter(task =>
        (!created_from || task.createdDay >= created_from) &&
        (!created_to || task.createdDay <= created_to) &&
        (status === 'all' || (task.completedAt === null ? status === 'pending' : status === 'completed')) &&
        (!query || task.text.toLocaleLowerCase().includes(query)),
      ).sort((a, b) => b.createdDay.localeCompare(a.createdDay) || a.createdAt - b.createdAt || a._id.localeCompare(b._id))
      return { tasks: tasks.slice(offset, offset + limit), total: tasks.length, next_offset: offset + limit < tasks.length ? offset + limit : null }
    },
    get_task: params => ({ task: repository.get(params.task_id) }),
    create_task: params => ({ task: repository.create(params.text) }),
    update_task(params) {
      const task = record(params)
      return { task: repository.edit(task, params.text) }
    },
    set_task_completed(params) {
      if (typeof params.completed !== 'boolean') throw new Error('completed 必须是布尔值。')
      const task = record(params)
      return { task: (task.completedAt !== null) === params.completed ? task : repository.setCompleted(task, params.completed) }
    },
    delete_task(params) {
      if (params.confirm !== true) throw new Error('删除需要用户明确确认，并传入 confirm: true。')
      const task = record(params)
      repository.remove(task)
      return { deleted: true, task_id: task._id }
    },
  }

  for (const [name, handler] of Object.entries(handlers)) {
    utools.registerTool(name, params => {
      onUse()
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('参数必须是 JSON 对象。')
      const properties = schemas[name].inputSchema.properties
      if (Object.keys(params).some(key => !Object.hasOwn(properties, key))) throw new Error('包含未支持的参数，请按工具 Schema 调用。')
      const result = handler(params)
      if (!['list_tasks', 'get_task'].includes(name)) onChange()
      return result
    })
  }
}

module.exports = { registerTaskTools }

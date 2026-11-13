# 快记 MCP

通过 uTools 内置 MCP Server 接入，不运行额外服务。六项能力在 `public/plugin.json` 中声明，由主窗口 preload 注册；窗口未打开时也可在后台处理，调用本身不弹出界面。

## 接入步骤

1. 构建并在 uTools 开发者工具的**原工程**中更新 `dist/plugin.json`，结束旧运行实例后再打开。
2. 在开发者工具的 **MCP 工具测试** 中检查六项工具和参数。
3. 在 **uTools 设置 → AI 设置 → MCP 服务** 启用服务，复制其中显示的地址，配置到自己的 MCP 客户端。
4. 让客户端重新发现工具。可以先查询任务，再用一条明确的测试记录验证新增、修改、完成、恢复和删除。

插件代码不会修改宿主服务设置或客户端配置。MCP 服务是否已开启、连接地址及访问控制以本机 uTools 界面为准。

## 工具

| 工具 | 能力 | 主要参数 |
| --- | --- | --- |
| `list_tasks` | 查询任务、按日回顾 | `created_from`、`created_to`、`status`、`keyword`、`offset`、`limit` 均可选 |
| `get_task` | 读取一条任务及最新版本 | `task_id` |
| `create_task` | 添加一条今天的待办 | `text` |
| `update_task` | 修改正文 | `task_id`、`expected_revision`、`text` |
| `set_task_completed` | 完成或恢复任务 | `task_id`、`expected_revision`、`completed` |
| `delete_task` | 删除单条任务 | `task_id`、`expected_revision`、`confirm: true` |

查询日期为创建时记录的本地日期，格式 `YYYY-MM-DD`，起止边界均包含。`status` 为 `all`（默认）、`pending` 或 `completed`。关键词在正文中匹配，英文不区分大小写。

列表按创建日从近到远、日内按创建时间从早到晚排列。默认 50 条，单次最多 200 条，结果包含 `total` 和 `next_offset`；`next_offset` 非空时可继续查询，不会静默截断成“只有这些任务”。

任务返回现有数据格式：`_id`、`_rev`、`text`、`createdAt`、`createdDay`、`completedAt`。把 `_id` 传为 `task_id`，把最新 `_rev` 传为 `expected_revision`。时间戳是毫秒，`completedAt: null` 表示未完成。

## 写入规则

- 新增任务默认归入本机今天；换行属于同一条正文，不拆成多条任务。
- 修改、完成和恢复都不改变创建日期。
- 完成操作是设置明确状态，不是反转；重复设为完成不会改写完成时间。
- 修改或删除前先读取并核对最新任务；过期版本被拒绝，不能靠自动重试覆盖别处的修改。
- 删除只支持一个明确任务 ID。调用端应先获得用户确认，再传 `confirm: true`；该参数只表达明确的删除意图，插件不会额外弹出窗口确认。
- 不提供批量清空、修改创建日期、改设置或窗口控制工具。写入成功后刷新已打开的两个界面，正在编辑的草稿仍受冲突保护。

## 调用示例

查询指定一天的未完成任务：

```json
{
  "created_from": "2026-11-12",
  "created_to": "2026-11-12",
  "status": "pending"
}
```

新增：

```json
{
  "text": "确认导出表格里的日期格式"
}
```

完成（ID 和版本必须换成实际读取的返回值）：

```json
{
  "task_id": "quick-note/task/实际任务ID",
  "expected_revision": "实际返回的_rev",
  "completed": true
}
```

## 验证范围

离线测试覆盖六项工具的注册、参数校验、筛选与分页、数据写入、版本冲突、删除确认及后台调用不弹窗；构建后的 CommonJS 仓库也完成隔离检查。测试均使用内存数据。

2026-11-12，用户已确认开发者工具可列出六项工具。外部 MCP 客户端通过真实 uTools MCP 服务的读写调用尚未联调。

官方资料：[MCP 集成](https://www.u-tools.cn/docs/development/mcp.html)、[工具注册 API](https://www.u-tools.cn/docs/api-reference/ai.html)。

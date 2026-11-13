# 快记 · Quick note

**随手记一笔，做完勾一下。**

快记是一个 uTools 桌面待办插件。用快贴随手记录，用时间线按创建日期回看任务。项目使用 Vue 3、Vite 和 JavaScript，任务保存在 uTools 数据库。

## 安装

项目面向 uTools 8，构建需要 Node.js 22.12 或更高版本。

```powershell
npm ci
npm run build
```

1. 在 uTools 中安装并打开「开发者工具」，新建本地项目并选择 `dist/plugin.json`。
2. 点击「安装（开发模式）」，然后点击「打开」，也可在 uTools 搜索框输入 `快记`。

更新时沿用开发者工具中的原项目，任务和设置会继续使用同一个应用 ID 对应的数据。

## 使用

- **快记** 打开主界面。设置里的「启动时自动打开快贴」默认关闭。开启后，插件冷启动只显示快贴，运行中再次打开会显示主界面。
- **快记时间线** 按创建日期分列显示记录。点击右下角双箭头可收起或展开全部任务均已完成的日期列。
- **快贴** 打开或唤起桌面便签。默认置顶，可用图钉切换，拖动标题栏移动，拖动窗口边缘调整大小。
- 输入后按 `Enter` 新增，按 `Shift + Enter` 换行。点击任务文字编辑，按 `Enter` 或离开输入框保存，按 `Esc` 取消。
- 勾选复选框完成任务，再次点击可恢复。可从任务右侧菜单删除记录，删除前需要确认。
- 快贴默认划线显示完成项。选择「完成后隐藏」时，完成项会保留 5 秒，之后仍可从时间线恢复。
- 主界面和快贴的滚动条在滚动时显示，停止后自动隐藏。

### 快贴窗口

在设置中开启「贴边自动收起」后，将快贴拖到屏幕顶部、左侧或右侧外沿即可停靠。鼠标移出后收起，悬停边缘时展开，焦点留在当前应用。输入草稿、编辑任务和输入法选词期间保持展开。贴边收起适用于未被任务栏占用的桌面外沿。

Windows 11 22H2 及以上版本默认使用 Acrylic 毛玻璃。快贴启动时通过 Windows PowerShell 设置原生材质，调用失败时回退到 Electron 的 Acrylic。系统的透明效果、节能和窗口状态可能影响实际显示。

需要快贴在主界面隐藏后常驻时，请在 uTools 的插件设置中关闭「退出到后台立即结束运行」。

## MCP 接入

通过 uTools 内置 MCP 服务查询、读取、新增、修改、完成或恢复待办，以及删除单条记录。在 **uTools 设置 → AI 设置 → MCP 服务** 中启用服务，将显示的地址填入 MCP 客户端。 [MCP 工具与接入说明](docs/mcp.md)

## 开发与打包

- `npm test` 运行离线测试。
- `npm run test:browser` 在 Windows 的 Chrome 或 Edge 中使用模拟宿主检查页面，运行前先构建。
- `npm run check` 依次执行离线测试、构建和浏览器检查。
- `npm run package` 在 `release/` 生成带时间戳的 `.upx` 安装包和 SHA-256 校验文件。也可在 uTools 开发者工具中导入 `dist/plugin.json` 后打包。

应用市场简介和详细介绍可参考项目的发布文案。 [发布文案](docs/store-listing.md)

## 项目结构与数据

| 位置 | 内容 |
| --- | --- |
| `src/` | Vue 界面、任务分组、编辑和存储逻辑 |
| `public/preload.js` | uTools 指令入口和双窗口通信 |
| `public/window-state.cjs` | 快贴窗口、贴边动画和位置恢复 |
| `public/windows-acrylic.cjs` | Windows 原生毛玻璃 |
| `public/mcp-tools.cjs` | MCP 工具注册和参数校验 |
| `scripts/` | 构建、浏览器检查和打包脚本 |

任务和设置保存在 uTools 数据库中，同步由宿主设置决定。窗口位置、尺寸、置顶和停靠方向保存在本机。保存失败时会保留草稿，版本冲突时会展示最新内容供核对。

uTools 开发者文档。 [自定义窗口](https://www.u-tools.cn/docs/development/custom-window.html) · [数据库](https://www.u-tools.cn/docs/api-reference/db.html) · [运行与调试](https://www.u-tools.cn/docs/getting-started/run-debug.html)

## 1. 项目脚手架与构建

- [ ] 1.1 初始化 `package.json` + `pnpm-workspace.yaml`,声明 Electron 30+、React 18、TypeScript 5、Vite 5、electron-vite、electron-builder、Cordis 与 DeepSeek Harness (`@deepseek-ai/cordis*` + `@deepseek-ai/dsh-*` 全部钉到 `0.1.5-rc.2`, `@earendil-works/pi-ai` 钉到 `0.85.1`) 依赖,并验证 `pnpm install` 成功生成 `node_modules` 与 `pnpm-lock.yaml`。
- [ ] 1.2 配置 `electron-vite` 的 `main / preload / renderer` 三端构建,确认 `pnpm dev` 启动后主进程窗口能显示空白 React 页面 (打印 `app:ready` 与 `window:loaded`)。
- [ ] 1.3 配置 `electron-builder` 的 `windows/nsis`、`mac/dmg`、`linux/AppImage` 三平台 target,验证 `pnpm dist:win` 在 Windows 主机产出 `dist/*.exe`。
- [ ] 1.4 配置 ESLint + Prettier + Vitest + Playwright(Electron)脚本,验证 `pnpm test` 与 `pnpm lint` 均返回 0。
- [ ] 1.5 配置 `@electron/rebuild`,验证安装 `better-sqlite3` 后 `pnpm rebuild` 成功,无 ABI 错误。

## 2. 共享类型与 IPC Schema

- [ ] 2.1 在 `src/shared/ipc-schema.ts` 中声明所有 IPC channel 及其 request/response 类型 (todo.* / content.* / drawing.* / ai.* / settings.*),验证 `pnpm tsc --noEmit` 通过。
- [ ] 2.2 在 `src/shared/todo-types.ts` 与 `src/shared/ai-types.ts` 导出 `Todo`、`Tag`、`Project`、`Status`、`ParsedTodo`、`Summary` 等类型,验证在 main/preload/renderer 三端 `pnpm tsc --noEmit` 通过。
- [ ] 2.3 在 `src/main/ipc/router.ts` 中实现通用 channel 校验器:未在 schema 中声明的 channel 拒绝并返回 `unknown_channel` 错误,验证单元测试 `router.spec.ts` 覆盖命中/未命中两条路径。

## 3. 数据层与文件落盘

- [ ] 3.1 实现 `src/main/db/schema.sql` 与迁移执行器,验证首次启动在 `~/.todo-list/` 下生成 `db.sqlite` 并执行所有 DDL,FTS5 触发器可用 (`PRAGMA integrity_check` 返回 `ok`)。
- [ ] 3.2 在 `src/main/db/todo-repo.ts` 实现 `TodoRepo.list/get/create/update/delete/batchUpdate/search`,验证单元测试覆盖排序、筛选、分页与 FTS 命中。
- [ ] 3.3 实现 `src/main/files/markdown.ts` 提供 `readBody/writeBody/history/restoreVersion`,验证每次保存写入 `todos/<id>.md` 与 `content_versions` 一行,且版本上限 20 生效。
- [ ] 3.4 实现 `src/main/files/drawings.ts` 提供 `saveDrawing/listDrawings/readDrawing`,验证落盘 `<todo-id>/<drawing-id>.excalidraw` 与 SQLite `drawings` 表一致。
- [ ] 3.5 实现 `src/main/files/thumbs.ts` 提供 `regenerateThumbnail(drawingId)`,验证 PNG 文件落盘且尺寸符合 320×200 约定 (断言文件存在且宽高匹配)。

## 4. 主进程能力

- [ ] 4.1 在 `src/main/index.ts` 装配单实例锁、窗口工厂、`contextIsolation/sandbox` 开启、preload 加载,验证同时启动两个实例第二个被拒绝并聚焦已有窗口。
- [ ] 4.2 实现 `src/main/shortcuts/index.ts` 注册默认全局快捷键 `CommandOrControl+Shift+T` 唤起 capture 窗口,验证热键在系统托盘隐藏状态下 200ms 内可见窗口。
- [ ] 4.3 实现 `src/main/tray/menu.ts` 的托盘菜单 (Quick capture / Open inbox / Pause clipboard watcher / Quit),验证菜单项点击触发对应 IPC。
- [ ] 4.4 实现 `src/main/clipboard/watcher.ts` 提供 `start/stop`,验证 `save clipboard as TODO` 命令把当前文本/图片写入 inbox-attachments。
- [ ] 4.5 实现 `src/main/settings/index.ts` 持久化 `config.json` (DeepSeek API key、`deepseek-chat`/`deepseek-reasoner` 切换、hotkey、theme),验证设置更改后进程重启仍生效。
- [ ] 4.6 集成 `electron-updater`,验证启动时检查更新 feed,在测试 feed 下 mock 一个新版本并观察到 `update-available` 事件。

## 5. Preload 桥与渲染层基础

- [ ] 5.1 在 `src/preload/index.ts` 通过 `contextBridge.exposeInMainWorld('todoList', api)` 暴露与 schema 对应的方法,验证在渲染进程中 `window.todoList.todo.list` 可用且 `require` 不可用。
- [ ] 5.2 在 `src/renderer/lib/ipc-client.ts` 封装 `window.todoList` 调用,统一错误处理 (toast + 上报),验证单元测试覆盖错误分支。
- [ ] 5.3 搭建 React 路由 (`/inbox` `/all` `/kanban` `/calendar` `/todo/:id` `/settings`) 与基础布局 (侧栏 + 内容 + AIPanel),验证冷启动 1s 内可交互。

## 6. TODO 视图与编辑器

- [ ] 6.1 实现 Inbox 视图与"快速创建"输入,验证创建一条 TODO 后 200ms 内出现在列表并写入 `db.sqlite` + `todos/<id>.md`。
- [ ] 6.2 实现 All 列表视图 (按状态/优先级/项目/标签 过滤 + 排序),验证拖拽改变优先级生效并触发 `todo.update`。
- [ ] 6.3 实现 Kanban 视图 (按状态分列 + DnD 跨列改状态),验证 `status` 改变同步到 DB 与 `.md` front-matter。
- [ ] 6.4 实现 Calendar 视图 (按 due_at 分日 + 未排期 lane),验证为 TODO 设置 due date 后落入对应日格。
- [ ] 6.5 在详情视图集成 Markdown 编辑器 (CodeMirror 6) + 预览,验证输入同步滚动、保存原子写入 DB 与文件、版本表新增一行。
- [ ] 6.6 实现版本历史面板与回滚,验证回滚到旧版本后 `content_versions` 中追加新行,UI 显示为最新版本。
- [ ] 6.7 实现全文搜索面板 (Cmd/Ctrl+K),验证输入 "登录" 返回按相关性排序的结果,标题命中排在正文命中之前。

## 7. Excalidraw 集成

- [ ] 7.1 自托管 `@excalidraw/excalidraw` 静态资源到 `renderer/public/excalidraw/`,验证离线模式下画布加载且无 CDN 404。
- [ ] 7.2 实现 `DrawingPanel` (新建 / 列出 / 删除 / 打开),验证保存场景后 `drawings/<todo-id>/<id>.excalidraw` 文件落盘并出现在 TODO 缩略图区。
- [ ] 7.3 实现缩略图生成:主进程接受来自渲染进程的 canvas dataURL,落盘为 PNG 并更新 `drawings.thumb_path`,验证列表中 1s 内显示缩略图。
- [ ] 7.4 实现 `[[todo:xxx]]` 双向链接 (Markdown 中与 Excalidraw 元素中),验证点击跳转目标 TODO 并高亮 backlinks 区。
- [ ] 7.5 实现 backlinks 面板 (基于 `link_index` 表),验证新建引用后 backlinks 区实时更新。

## 8. AI 助手 (DeepSeek Harness)

- [ ] 8.1 在 `package.json` 中固定 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-deepseek`、`@deepseek-ai/dsh-llm-pi-ai` 到 `0.1.5-rc.2`,并把 `@earendil-works/pi-ai` 钉到 `0.85.1`,验证 `pnpm install` 成功,无 `latest` / `*` 范围。
- [ ] 8.2 在 `src/main/dsh/container.ts` 创建 Cordis 容器并导出 `initDshContainer(deps)`,仅暴露无凭据的 `{ health, models }` 句柄;真正的 agent 循环在 `src/main/dsh/dsh-runtime.ts` 中由 `getDshRuntime()` 在首次 `ai.ask` 时懒加载,验证启动日志显示 `DSH handle ready (real runtime is lazy on first ai.ask)`。
- [ ] 8.3 在 `registerDomainTools`(`src/main/dsh/dsh-runtime.ts`)中实现 `todo_*` / `content_*` / `drawing_*` 工具,把我们的 IPC handler 注册成 DSH tools(`todo_list` / `todo_get` / `todo_search` / `todo_stats` / `todo_create` / `todo_update` / `todo_delete` / `todo_restore` / `content_readBody` / `content_writeBody` / `content_history` / `content_restoreVersion` / `drawing_list` / `drawing_read` / `drawing_save` / `drawing_delete`),验证 DSH 的 tool registry 中能列出这些工具。
- [ ] 8.4 实现 AI "自然语言采集" 流(走 `ai.ask` IPC + `intent: 'create-task'`,主进程在 `src/shared/task-creation.ts` 编码 `[todo-list:create-task:v1]` 信封):在 capture window 输入"明天 10 点和 Bob 评审登录页 !p1 @work",渲染端 AI 面板调 `ai.ask`,模型返回 `todo.create` 调用,落地为新的 TODO。
- [ ] 8.5 实现 `draftProgress` 与 `summarize` 流(均通过 DSH skills),使用 `dsh-agent-loop` 流式推理,逐 token 通过 `ai:stream` push 推到渲染层,验证 AIPanel 实时增长。
- [ ] 8.6 实现 `analysis` skill:读取 `todo_search({createdAfter})` 与 `todo_stats`,调 `deepseek-reasoner` 生成周报,调用 `content_writeBody` 写回"周报-<YYYY-Www>"TODO,验证 AIPanel 触发后 5 秒内打开对应 TODO 看到内容。
- [ ] 8.7 配置 `src/shared/permission-tiers.ts` 的三级权限闸(`auto` / `notify-undo` / `block`)拦截 `todo_delete` / `content_writeBody`(非空时)/ `content_restoreVersion` / `drawing_delete`,在 `registerDomainTools` 入口查 `tierFor()`:notify-undo 通过 `ai:undo-toast` IPC 推 8 秒撤销 toast;block 通过 IPC 触发渲染进程确认 modal,30 秒未确认自动拒绝。
- [ ] 8.8 在 settings 中允许用户切换 provider (`deepseek` / `openai` / `anthropic` / `ollama` / `custom`) 与 model,验证切换后下一次 AI 调用使用新配置(无需重启)。
- [ ] 8.9 处理 provider 失败(disconnected / no_key / error),AIPanel 顶部展示状态,验证断网下其余 TODO 功能可用;若 boot 阶段就失败,`ai.status === 'failed'`,AI 面板展示「重试」按钮调 `app.startupRetry('ai')`(UX-01)。
- [ ] 8.10 添加 ESLint 规则禁止 `package.json` 中 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis*` 使用 `latest` / `*`,验证 CI 跑 lint 通过。

## 9. 外部脚本 / 插件接入 (JSON-RPC 桥, SEC-01)

- [ ] 9.1 在 `src/main/sdk/sdk.ts` 实现 `TodoListSdk`,镜像 IPC 表面(todo / content / drawing / settings / ai.conversation / app)。
- [ ] 9.2 在 `src/main/sdk/bridge.ts` 实现 JSON-RPC 2.0 桥(line-delimited JSON),Unix socket (`/tmp/todo-list.sock`) / Windows 命名管道 (`\\.\pipe\todo-list`) 双传输,只在 `SettingsStore.sdkBridge.enabled === true` 且 capability token 存在时启动(SEC-01),验证默认未启动时 `${userData}/todo-list.log` 中看不到 `bridge:` 行。
- [ ] 9.3 在 `src/shared/sdk-types.ts` 与 `TodoListSdk` 之间定义 token 校验、来源标记、调用计数;每条 bridge 日志只记 `bridge: <phase> <method> <count>`,绝不记参数或 token。
- [ ] 9.4 集成测试:mock JSON-RPC client 连入后调 `todo.list` / `todo.get` / `todo.create` / `todo.update` / `todo.delete` 五条路径,验证全部成功且审计日志可追溯。

## 10. 打包、签名与发布

- [ ] 10.1 启用 `electron-updater` 默认 GitCode Releases feed(`package.json → build.publish` 指向 `https://gitcode.com/ai-sea/ai-todo-list/releases/latest`),在测试仓库发版验证 `pnpm dist:win` 产物可被检测并下载。
- [ ] 10.2 文档化 `pnpm dist:win|mac|linux` 三命令,验证 README 描述与实际产物一致 (Windows NSIS / macOS DMG / Linux AppImage)。
- [ ] 10.3 在 CI (GitHub Actions) 中加入 `windows-latest` / `macos-latest` / `ubuntu-latest` 矩阵,运行 lint+test+dist,验证 PR 上 CI 全绿。
- [ ] 10.4 在 `package.json` 中声明 `appId`、`productName`、`copyright`,验证安装时显示正确名称与版本。

## 11. 测试与质量

- [ ] 11.1 单元测试覆盖 `TodoRepo`、`MarkdownFile`、`DrawingFile`、`Router`、`AI agent` 关键路径,验证 `pnpm test --coverage` 行覆盖 ≥ 80%。
- [ ] 11.2 编写 Playwright E2E:启动应用 → 创建 TODO → 编辑 MD → 添加绘图 → AI 解析 → 归档,验证一次完整流程无控制台错误。
- [ ] 11.3 添加 `npm audit` / `pnpm audit` 脚本,验证流水线高危漏洞 = 0。

## 12. 文档

- [ ] 12.1 编写 `README.md` 含特性介绍、快速开始、键盘映射、AI 配置说明,验证新用户按文档能在 5 分钟内创建第一条 TODO。
- [ ] 12.2 编写 `docs/architecture.md` 引用 `openspec/changes/todo-list-desktop/design.md` 概要并配 1 张进程边界图,验证开发者 onboarding 文档完备。
- [ ] 12.3 在 `openspec/specs/` 下确认六份 capability spec 在 archive 时合并成功 (`openspec archive todo-list-desktop --yes` 后 `openspec/specs/` 出现对应目录)。
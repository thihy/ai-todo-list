## Context

项目刚刚初始化 (`openspec init --tools claude` 完成),目前仅有 `openspec/` 目录与配置,无任何运行代码。需要从零搭建一个 Electron 桌面应用,作为 AI 原生的 TODO 工具。

约束:
- 离线优先,数据全部落在用户本地 (`~/.todo-list/`)。
- AI 仅作为可选云端能力,需可关闭、可降级、可在用户自托管/OpenAI/Anthropic 之间切换。
- 渲染层不可接触 Node API,所有跨进程能力必须经由受控 IPC。
- 跨 Windows / macOS / Linux 一套代码,差异点收敛在 `desktop-runtime`。

见 `proposal.md - Why` 获取动机,见 `specs/` 各 capability 获取行为契约。

## Goals / Non-Goals

**Goals:**
- 给出可执行的技术栈与目录结构,后续 `tasks.md` 能按模块直接拆任务。
- 定义进程边界与 IPC schema,让"安全模型"在代码落地前就明确。
- 给出数据模型与文件落盘格式,使 SQLite、Markdown、Excalidraw 三者有一致的关联方式。
- 明确 AI 调用的代理链路,确保密钥不进入渲染层、流式响应能被前端消费。

**Non-Goals:**
- 不实现多端同步 / 云端协作(本地优先,后续可加)。
- 不实现插件市场 / 第三方扩展点(MCP 接口已覆盖外部 agent 调用,暂时不开 UI 扩展)。
- 不绑定具体 AI Provider SDK 实现细节,仅定义接口,允许后续切换。
- 不做移动端。

## Decisions

### 1. 技术栈
- **桌面壳**: Electron 30+,`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- **构建**: Vite 5 + electron-builder,使用 `electron-vite` 统一主/preload/renderer 三端构建。
- **UI**: React 18 + TypeScript + Zustand(状态) + Tailwind CSS(样式) + Radix UI(无样式可访问原语)。
- **数据**: SQLite via `better-sqlite3`(同步、性能好、主进程独占) + 文件系统(Markdown / Excalidraw JSON / 缩略图)。
- **Markdown**: CodeMirror 6(编辑器) + `unified/remark/rehype` 管线 + `gray-matter` front-matter。
- **绘图**: Excalidraw 包(`@excalidraw/excalidraw`),自托管静态资源,渲染进程嵌入。
- **AI**: DeepSeek Harness (DSH) 作为进程内库嵌入:在主进程内构造一个 Cordis 容器,引入 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop` + `@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-skill` + `@deepseek-ai/dsh-session-persistence-jsonl` + `@deepseek-ai/dsh-llm-deepseek` + `@deepseek-ai/dsh-llm-pi-ai`(后者再委托 `@earendil-works/pi-ai` 做流式 / SSE / per-provider reasoning delta);默认 LLM 走 DeepSeek(`https://api.deepseek.com/v1`),通过设置面板可切换到 OpenAI / Anthropic / Ollama 或自填 OpenAI-compatible endpoint,API key 仅主进程持有。
- **外部 Agent**: 在主进程内暴露 JSON-RPC 桥(`src/main/sdk/bridge.ts`),Unix socket / Windows 命名管道双传输,**默认关闭**,开启时需 capability token(SEC-01)。
- **测试**: Vitest(单元) + Playwright(E2E,含 Electron 启动)。

**备选**:
- Tauri vs Electron: 选 Electron 因 Excalidraw 与 Markdown 编辑器生态成熟、Tauri 体积虽小但需额外做 webview 兼容。
- Vue vs React: 选 React 因 Excalidraw 官方包为 React 组件,集成阻力最小。
- 原生 SQLite vs lowdb/JSON: 选 SQLite 因需全文检索、批量更新、跨表事务。

### 2. 进程与目录结构
```
src/
├── main/                       # Node 进程
│   ├── index.ts                # 应用生命周期、单实例锁、自动更新
│   ├── ipc/                    # 强类型 IPC handler 注册中心
│   ├── db/                     # better-sqlite3 schema、迁移、查询
│   ├── files/                  # Markdown / Excalidraw 落盘与索引同步
│   ├── dsh/                    # DSH runtime (eager container + lazy dsh-runtime + adapter + skills + endpoints)
│   ├── sdk/                    # JSON-RPC bridge (off by default, capability token)
│   ├── shortcuts/              # globalShortcut 注册与 capture window 唤起
│   └── tray/                   # 系统托盘菜单
├── preload/                    # contextBridge 桥
│   └── index.ts                # 暴露 window.todoList.* 受限 API
├── renderer/                   # 浏览器进程
│   ├── views/                  # Inbox / List / Kanban / Calendar / Detail
│   ├── components/             # 通用组件(Editor、DrawingPanel、AIPanel等)
│   ├── stores/                 # Zustand stores
│   ├── routes/                 # 路由(router-dom)
│   └── lib/                    # ipc-client 封装、纯前端工具
└── shared/                     # 主/preload/renderer 共享类型
    ├── ipc-schema.ts           # IPC channel 与类型映射(单一事实源)
    ├── todo-types.ts       # TODO / Tag / Project / Status 等类型
    └── ai-types.ts             # AI 请求/响应/事件类型
```
**主进程独占** DB、文件落盘、AI/MCP 出口、剪贴板监听、托盘、全局快捷键、窗口管理。
**渲染进程独占** UI、编辑器、画布、状态展示。

### 3. IPC Schema(`src/shared/ipc-schema.ts`)
每个 channel 是一个 `{ channel, request, response, events? }` 对象,注册/调用两侧都引用该 schema,避免字符串散落。

最小集合(初版):
- `todo.list { filter } → Todo[]`
- `todo.get { id } → Todo | null`
- `todo.create { input } → { id }`
- `todo.update { id, patch } → Todo`
- `todo.delete { id } → void`
- `todo.search { query } → SearchHit[]`
- `todo.batchUpdate { ids, patch } → Todo[]`
- `content.readBody { id } → { markdown, version }`
- `content.writeBody { id, markdown } → { version }`
- `content.history { id } → VersionEntry[]`
- `content.restoreVersion { id, versionId } → void`
- `drawing.list { todoId } → DrawingMeta[]`
- `drawing.read { drawingId } → ExcalidrawScene`
- `writing.save { todoId, scene } → { drawingId }`
- `ai.parseCapture { text } → ParsedTodo`
- `ai.draftProgress { todoId, hint? } (stream) → Markdown`
- `ai.summarize { todoId } (stream) → Summary`
- `ai.streamEvent (push) → token/error/done`
- `settings.get / settings.set`

未在 schema 中的 channel 由 `ipc/main.ts` 拦截并返回 `unknown_channel` 错误。

### 4. 数据模型(SQLite)
```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,                 -- ULID
  title TEXT NOT NULL,
  status TEXT NOT NULL,                -- inbox|next|doing|blocked|done
  priority TEXT NOT NULL,              -- very-low|low|medium|high|very-high
  project TEXT,                        -- 单值,引用 projects.slug
  due_at INTEGER,                      -- unix ms
  body_path TEXT NOT NULL,             -- 相对 ~/.todo-list/todos/<id>.md
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX idx_todos_status ON todos(status);
CREATE INDEX idx_todos_due_at ON todos(due_at);
CREATE INDEX idx_todos_project ON todos(project);

CREATE TABLE tags (
  todo_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(todo_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);

CREATE TABLE drawings (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  title TEXT,
  path TEXT NOT NULL,                  -- ~/.todo-list/drawings/<todo_id>/<id>.excalidraw
  thumb_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_drawings_todo ON drawings(todo_id);

CREATE TABLE content_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id TEXT NOT NULL,
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX idx_versions_todo ON content_versions(todo_id, saved_at DESC);

CREATE TABLE link_index (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- body|drawing
  PRIMARY KEY(from_id, to_id, kind)
);

CREATE VIRTUAL TABLE todos_fts USING fts5(title, body, content='todos', content_rowid='rowid');
```
全文搜索由 FTS5 触发器自动同步 `title` 与 Markdown `body`。

### 5. 文件落盘
- **Markdown**:每次保存写入 `todos/<id>.md`,front-matter 与 DB 镜像(以 DB 为权威,文件由 DB 投影)。`content_versions` 保留最近 20 个版本 + 周期全量快照。
- **Excalidraw**:每次保存直接写 `<drawing-id>.excalidraw`,缩略图用 `excalidraw` 包的导出能力生成 PNG(主进程 Node 端使用 `canvas` 或调渲染进程导出后通过 IPC 回传)。
- **配置**:`~/.todo-list/config.json`(AI provider、快捷键、主题)。

### 6. AI 代理链路(DSH 作为 Cordis 容器)
- 启动时 `src/main/dsh/container.ts` 构造一个 Cordis 容器并导出 `initDshContainer(deps)`,主进程持有。该 eager 路径只暴露 `{ health, models }` 句柄,无需凭据即可响应 IPC。
- 真正的 agent 循环在 `src/main/dsh/dsh-runtime.ts` 懒加载:首次 `ai.ask` 时动态 `await import('@deepseek-ai/dsh-app-boot')`,解析 `resources/dsh/cordis.yml`,在同一个 Cordis 容器内:
  - `@deepseek-ai/cordis` 容器基础 + `@deepseek-ai/cordis-plugin-*` 插件组
  - `@deepseek-ai/dsh-base` 基础 bundle
  - `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop` 推理循环
  - `@deepseek-ai/dsh-tools` tool 注册表
  - `@deepseek-ai/dsh-skill` skill 注册表
  - `@deepseek-ai/dsh-session` + `@deepseek-ai/dsh-session-persistence-jsonl` 会话状态与 JSONL 持久化
  - `@deepseek-ai/dsh-llm` + `@deepseek-ai/dsh-llm-deepseek` + `@deepseek-ai/dsh-llm-pi-ai` LLM 抽象与多 provider 适配
- 我们注册的领域工具(在 `registerDomainTools` 中,同样挂在该 Cordis 容器上):
  - `todo_*`:`todo_list` / `todo_get` / `todo_search` / `todo_stats` / `todo_create` / `todo_update` / `todo_delete` / `todo_restore`,封装 `TodoRepo` + IPC schema
  - `content_*`:`content_readBody` / `content_writeBody` / `content_history` / `content_restoreVersion`
  - `drawing_*`:`drawing_list` / `drawing_read` / `drawing_save` / `drawing_delete` / `drawing_setThumb`
- 我们注册的 skill(在 `src/main/dsh/skills.ts`):`todo-ops` / `content-ops` / `drawing-ops` / `analysis`,每个 skill 把若干 tool 与提示词片段打包,用户可在设置中按需开启。
- 渲染进程(AI 面板)只通过 `window.todoList.ai.*` IPC 与主进程对话,**没有 stdio / 没有子进程**——所有 agent 事件由主进程订阅后通过 `ai:stream` 等 push 事件回推。
- 流式响应:渲染进程发起 `ai.ask` IPC,主进程订阅 DSH 的 token / reasoning / tool-call 事件,通过 `ai:stream` push 回渲染层;AIPane 的 `BlockAssembler` 直接消费上游 `StreamChunk`,不在渲染层重做拼装。
- 系统提示词与 skill 模板定义在 `resources/dsh/`,允许用户后续自定义。
- 权限:危险 tool 的三级分级(`auto` / `notify-undo` / `block`)由宿主侧的 `src/shared/permission-tiers.ts` 拥有,`registerDomainTools` 在执行前先查 `tierFor()`:auto 直接跑,notify-undo 推到渲染层弹 8 秒撤销 toast,block 弹显式确认 dialog,30 秒未确认自动拒绝。
- DeepSeek 不可达时,AIPanel 顶部展示明确状态(disconnected / no_key / error),其余能力照常可用;`ai.health` 在该场景下返回 `{ ok: false, mode: 'real' }` 由 IPC 错误码携带原因。
- 版本钉死:`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis*` 全部钉到 `0.1.5-rc.2`(`@earendil-works/pi-ai` 钉到 `0.85.1`),避免 RC 漂移破坏集成;升级时必须走独立的 OpenSpec 变更并重跑 `pnpm typecheck` + `pnpm test`。

### 7. Excalidraw 嵌入策略
- 自托管 `@excalidraw/excalidraw` 静态资源到 `renderer/public/excalidraw/`,避免 CDN 失败。
- 渲染进程侧加载:每个 TODO 详情页挂一个 `DrawingPanel`,使用 `updateScene` API 反序列化存储 JSON。
- 缩略图由 Excalidraw `exportToCanvas` 渲染后转 PNG,经 IPC 提交主进程落盘。
- 自定义 `[[todo:xxx]]` 链接:在 `onPointerUp` 中扫描选中元素的 `link` 字段;在侧边栏显示"关联 TODO"。

### 8. 窗口类型
- `main`:主窗口,持有完整 UI。
- `capture`:无边框小窗口,仅文本框 + 解析预览,使用 `alwaysOnTop: true` 与 `show: false`,全局快捷键唤起。
- `settings`:模态,AI provider 等配置。
- 共享一个 `BrowserWindow` 工厂,统一应用安全策略。

### 9. 自动化与发布
- 使用 `electron-updater` + GitCode Releases 作为默认 feed(`package.json → build.publish` 声明 `https://gitcode.com/ai-sea/ai-todo-list/releases/latest`)。
- CI 矩阵:`windows-latest`、`macos-latest`、`ubuntu-latest`,均跑 `pnpm test` + `pnpm dist`。
- 数字签名:Windows 用 Azure Trusted Signing 或后续签;macOS 用 notarization。

## Risks / Trade-offs

- **better-sqlite3 原生模块**需要为每个 Electron 版本匹配 ABI → 使用 `electron-rebuild` / `@electron/rebuild` 在安装时自动重建,失败回退到 `node-sqlite3-wasm`。[Risk: 安装失败] → Mitigation: 文档说明 Node 版本要求,提供 `pnpm rebuild` 脚本。
- **Excalidraw 包较大**(~MB 级) → Mitigation: 自托管静态资源 + 路由级懒加载,只在打开含绘图 TODO 时才加载。
- **AI Provider 锁定为 DeepSeek** → Mitigation: 通过 DSH 的 `dsh-llm-deepseek` 适配器接入,后续若 DeepSeek 出新版 API 仅升级该适配器。
- **本地 Markdown 与 DB 双写一致性** → Mitigation: 以 DB 为权威,文件是投影;每次事务结束由主进程串行写文件,失败仅记录警告,不回滚 DB(由下次启动 reconcile 重建)。
- **缩略图生成阻塞** → Mitigation: 在 Excalidraw 保存成功后异步生成,UI 先显示占位,生成完成后再替换。
- **MCP 与 IPC schema 复用** → 复用 `shared/ipc-schema.ts`,避免两套定义漂移;但 MCP 工具描述需要单独映射到 schema 中的子集。
- **跨平台快捷键冲突** → Mitigation: 默认快捷键可在 settings 中改;在 macOS 注册时把 `CommandOrControl` 替换为 `Command`。
- **DSH RC 版本不稳**(`0.1.5-rc.2`,官方明示 breaking changes 仍在 RC 阶段) → Mitigation: 全部 `@deepseek-ai/dsh-*` + `@deepseek-ai/cordis*` 钉到 `0.1.5-rc.2`,`@earendil-works/pi-ai` 钉到 `0.85.1`,lockfile 锁版本;升级前在 `openspec/changes/<name>/` 内开升级变更做迁移评估;CI 跑 `openspec validate` 防止规范漂移。
- **首次启动没有 AI key** → Mitigation: 启动检测,无 key 时 AI 入口展示"配置"按钮而不报错。

## Migration Plan

- 项目从空目录起步,无既有用户,无迁移成本。
- 后续若引入云同步,可在 `src/main/sync/` 增加适配层,DB schema 保持向前兼容(`ALTER TABLE` + 迁移脚本)。

## Open Questions

- 是否需要在 v1 支持多窗口/多 workspace?默认不实现(单 workspace)。
- Markdown 编辑器是否同时支持 WYSIWYG(TipTap)?默认 CodeMirror 6 + 预览,不引入 WYSIWYG 以免复杂度上升;后续视反馈再决定。
# AI待办 · AI-native desktop TODO list

> [English](#english) · [中文](#中文)

---

## English

> An AI-native desktop TODO list built on top of DeepSeek Harness (DSH) — the agent runtime is the real `@deepseek-ai/dsh-*@0.1.5-rc.2` stack running in-process inside a Cordis container, not a shim. Capture fast, organize freely, write Markdown notes, sketch on Excalidraw, and ask the assistant directly — all inside one Electron app.

![status](https://img.shields.io/badge/status-RC_1.0.0--rc6-yellow)
![electron](https://img.shields.io/badge/electron-33-47848F)
![dsh](https://img.shields.io/badge/DSH-0.1.5--rc.2-blue)

### Highlights

- **Quick capture** — global hotkey `Ctrl+Shift+T` opens a small always-on-top composer. Drop a line, press `Ctrl+Enter`, back to whatever you were doing.
- **Markdown per TODO** — each TODO carries a full Markdown body with up to 20 historical versions, one-click restore. Every task lives in its own on-disk directory, so attachments, drawings and notes stay co-located.
- **Excalidraw sketches** — attach drawings to any TODO; thumbnails show up in the editor and open in a dedicated pane. Fonts are bundled locally.
- **Subtasks & Today view** — break a TODO into inline subtasks; the Today view splits planned vs. overdue and offers an AI guide for what to do next.
- **Command palette** — multi-select tasks from the palette and run batch actions (priority, tags, dates, delete) without touching the mouse.
- **Links with auto-fetched metadata** — paste a URL and the title + meta description are fetched automatically.
- **AI-native** — built **on top of** DSH, not bolted on. `todo.*`, `content.*`, and `drawing.*` are first-class DSH tools; the agent reads, drafts, and updates your work like a teammate. Three-tier permission (auto / notify+undo / block) decides what it can do without asking. Tool-call input/output can be toggled between JSON and plain text.
- **Task health check** — a report-only health sweep flags stale, orphaned, or inconsistent tasks and suggests fixes; no mutation without your approval.
- **Privacy-safe diagnostics** — export a diagnostic bundle with secrets redacted, for sharing bug reports.
- **No telemetry** — your API key, your data, your disk. The JSON-RPC bridge (Unix socket / Windows named pipe) is **off by default** with access protection, and is the only external surface.

### Quick start

```bash
pnpm install          # .npmrc enables shamefully-hoist + auto-install-peers
pnpm rebuild          # rebuild better-sqlite3 against Electron's Node ABI
node resources/build-tray-icon.mjs
pnpm dev
```

The app launches with an empty in-memory database under your platform's userData directory. Drop your DeepSeek API key into **Settings → DeepSeek API Key**, pick a model, and ask away.

### Build & ship

```bash
pnpm build            # produce out/ via electron-vite
pnpm typecheck        # tsc --noEmit across the three projects
pnpm test             # vitest run (unit + bridge + skills)
pnpm e2e              # playwright (requires pnpm build first)

pnpm dist             # electron-builder, native target
pnpm dist:win         # NSIS installer + portable
pnpm dist:mac         # DMG (x64 + arm64)
pnpm dist:linux       # AppImage + .deb
```

After a Windows build, run `pnpm test:packaged-dsh` to boot the DSH plugin tree directly from `dist/win-unpacked/resources/app.asar` under Electron. It uses temporary session data and makes no model requests. To check another installation, pass its resources directory as an argument. A successful dev boot is insufficient: pnpm can supply automatically installed peer dependencies that the packager omits. Required DSH runtime peers must be declared in the app's production dependencies and included in `pnpm-lock.yaml`.

### Architecture

```
┌─────────────────────── Renderer (React 18 + TS) ───────────────────────┐
│   Sidebar  │  TODO List  │  Editor (Markdown + Drawing)  │  AI Pane   │
│                       ▲ window.todoList.* (contextBridge)             │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ validated IPC router (src/main/ipc/router.ts)
┌─────────────────────── Main Process ───────────────────────────────────┐
│  ipc/router ─ todo/content/drawing/inbox/settings/ai handlers         │
│       │                                                               │
│       ├── db/TodoRepo ─┐                                              │
│       ├── files/MD  ──┴── better-sqlite3 + Markdown files             │
│       ├── files/Drawings (JSON scenes + thumbs)                       │
│       │                                                               │
│       └── dsh/container ── eager { health, models } handle            │
│              │                                                        │
│              └── dsh/dsh-runtime ── lazy @deepseek-ai/dsh-app-boot     │
│                     ├── dsh/llm-adapter (PiAiAdapter → pi-ai)         │
│                     ├── dsh/skills  (todo-ops, content-ops, …)        │
│                     ├── dsh/tools   (registerDomainTools)             │
│                     └── dsh/endpoints (deepseek/openai/anthropic/ollama/custom)
└───────────────────────────────────────────────────────────────────────┘
                        ▲
                        │ JsonRpcBridge (Unix socket / named pipe, off by default)
                        │
        ┌───────────────┴───────────────┐
        │   External scripts / plugins   │
        │   $ echo '{"jsonrpc":"2.0",    │
        │   "id":1,"method":"todo.list", │
        │   "params":{}}' | nc -U …sock  │
        └────────────────────────────────┘
```

### DSH integration model

The agent runtime is the real `@deepseek-ai/dsh-*@0.1.5-rc.2` stack,
imported via `npm` and wired together by
[`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis)
inside the Electron main process — there is no shim, no `dsh`
subprocess, and no stdio bridge. The dependency is declared in
`package.json` and pinned in `pnpm-lock.yaml`; `pnpm install`
succeeds without `ERR_PNPM_FETCH_404`.

#### Two halves of the runtime

- `src/main/dsh/container.ts` builds an eager `{ health, models }`
  handle the moment the main process boots. It answers
  `ai.health` / `ai.models` without needing credentials.
- `src/main/dsh/dsh-runtime.ts` lazily boots the real agent loop on
  the first `ai.ask`. It dynamically
  `await import('@deepseek-ai/dsh-app-boot')`, parses
  `resources/dsh/cordis.yml`, registers the
  `todo.*` / `content.*` / `drawing.*` tools via
  `registerDomainTools`, and constructs the `PiAiAdapter`
  from `@deepseek-ai/dsh-llm-pi-ai` (which delegates streaming,
  SSE parsing, and per-provider reasoning deltas to
  `@earendil-works/pi-ai`). The first `ai.ask` pays the Cordis
  cold-boot cost; subsequent calls share the singleton runtime.

The renderer never touches `window.todoList.ai.*` IPC differently
because of this split — the contract is the same either way.

#### Three permission tiers

The host owns the tier classification in
`src/shared/permission-tiers.ts`. Every tool registered by
`registerDomainTools` is gated through `tierFor(toolName)` before it
runs:

| Tier         | Example tools                    | UI                                  |
| ------------ | -------------------------------- | ----------------------------------- |
| auto         | `todo.list`, `content.readBody`  | runs silently                       |
| notify-undo  | `todo.update`, `content.writeBody` | 8-second undo toast                |
| block        | `todo.delete`, `content.restoreVersion` | explicit confirmation dialog    |

See `src/main/dsh/dsh-runtime.ts` (`registerDomainTools`) and
`docs/adr/006-json-rpc-bridge-capability-token.md` for the
external-script side of the same gate.

### Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` everywhere.
- Preload exposes only the typed `window.todoList.*` facade; the raw `ipcRenderer` is never reachable from page code.
- CSP set in both `index.html` and `capture.html`.
- API key is persisted under the OS userData dir and never re-sent to the renderer in cleartext — `publicView()` returns only a redacted version.
- JSON-RPC bridge is disabled by default and guarded with access protection.

### Accessibility

- WCAG 2.2 AA contrast for all foreground/background pairs in `src/renderer/styles/global.css`.
- `prefers-reduced-motion` honored in global CSS.
- Every tappable element has press + commit states.
- Live regions: statusbar (`aria-live="polite"`), AI pane (`role="log"`).

### License

MIT — see [LICENSE](./LICENSE).

### See also

- [AGENTS.md](./AGENTS.md) — concise implementation invariants for AI coding agents.
- [docs/task-creation-and-storage.md](./docs/task-creation-and-storage.md) — task creation, AI intent, and storage contracts.
- [DEVELOPING.md](./DEVELOPING.md) — local dev loop, code layout, conventions.
- [docs/architecture.md](./docs/architecture.md) — deeper architecture notes.
- [openspec/changes/todo-list-desktop/](./openspec/changes/todo-list-desktop/) — design specs.

---

## 中文

> 一个 AI 原生的桌面待办应用，构建于 DeepSeek Harness（DSH）之上——agent 运行时就是真正的 `@deepseek-ai/dsh-*@0.1.5-rc.2`，通过 Cordis 容器在 Electron 主进程内运行，没有 shim、没有子进程、没有 stdio 桥。
> 快速捕获、自由组织、写 Markdown 笔记、在 Excalidraw 上手绘、直接向助手提问——全部在同一个 Electron 应用内完成。

![status](https://img.shields.io/badge/status-RC_1.0.0--rc6-yellow)
![electron](https://img.shields.io/badge/electron-33-47848F)
![dsh](https://img.shields.io/badge/DSH-0.1.5--rc.2-blue)

### 特性亮点

- **快速捕获**——全局快捷键 `Ctrl+Shift+T` 弹出常驻顶层的小输入框。丢一句进去，`Ctrl+Enter` 提交，回到你刚才在做的事。
- **每个待办自带 Markdown**——每个 TODO 携带完整 Markdown 正文，最多保留 20 个历史版本，一键回滚。每个任务有独立的磁盘目录，附件、手绘、笔记同处一处。
- **Excalidraw 手绘**——任意待办可挂手绘；缩略图出现在编辑器中，点击进入专属画板。字体本地打包。
- **子任务与今日待办**——把 TODO 拆成内联子任务；今日待办视图分「计划内 / 已逾期」两段，并提供 AI 行动建议。
- **命令面板**——在面板里多选任务，批量改优先级、标签、日期、删除，无需动鼠标。
- **链接自动抓取元信息**——粘贴 URL 时自动抓取页面标题与 meta 描述。
- **AI 原生**——构建**在** DSH **之上**，而非外挂。`todo.*`、`content.*`、`drawing.*` 是 DSH 一等工具；助手像队友一样读、起草、更新你的内容。三级权限（自动 / 通知+撤销 / 拦截）决定它能在不询问的前提下做到哪一步。工具调用的输入输出可在 JSON 与纯文本间切换。
- **任务健康检查**——只读的健康扫描会标出陈旧、孤立或前后不一致的任务并给出修复建议；未经你同意不做任何修改。
- **隐私安全诊断包**——可导出一份屏蔽了敏感信息的诊断包，便于上报问题。
- **零遥测**——API key、数据、磁盘都在你本地。JSON-RPC 桥（Unix socket / Windows 命名管道）**默认关闭**并带访问保护，是唯一的对外接口。

### 快速开始

```bash
pnpm install          # .npmrc 已开启 shamefully-hoist + auto-install-peers
pnpm rebuild          # 将 better-sqlite3 重新编译到 Electron 的 Node ABI
node resources/build-tray-icon.mjs
pnpm dev
```

应用启动时会在平台 userData 目录下使用一个空的内存数据库。把 DeepSeek API Key 填进**设置 → DeepSeek API Key**，选模型，开聊。

### 构建与发布

```bash
pnpm build            # 通过 electron-vite 产出 out/
pnpm typecheck        # 对三个 project 跑 tsc --noEmit
pnpm test             # vitest run（单测 + 桥 + skills）
pnpm e2e              # playwright（需先 pnpm build）

pnpm dist             # electron-builder，本机目标
pnpm dist:win         # NSIS 安装包 + portable
pnpm dist:mac         # DMG（x64 + arm64）
pnpm dist:linux       # AppImage + .deb
```

Windows 构建后运行 `pnpm test:packaged-dsh`，直接从 `dist/win-unpacked/resources/app.asar` 在 Electron 下启动 DSH 插件树。它使用临时会话数据，不发任何模型请求。要检查其他安装，把其 resources 目录作为参数传入。仅 dev 启动成功是不够的：pnpm 会自动安装打包器遗漏的 peer 依赖，DSH 运行时所需 peer 必须声明在应用的生产依赖中并写入 `pnpm-lock.yaml`。

### 架构

```
┌─────────────────────── 渲染进程 (React 18 + TS) ───────────────────────┐
│   侧边栏  │  待办列表  │  编辑器 (Markdown + 手绘)  │  AI 面板        │
│                       ▲ window.todoList.* (contextBridge)             │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ 受校验的 IPC router (src/main/ipc/router.ts)
┌─────────────────────── 主进程 ─────────────────────────────────────────┐
│  ipc/router ─ todo/content/drawing/inbox/settings/ai 处理器          │
│       │                                                               │
│       ├── db/TodoRepo ─┐                                              │
│       ├── files/MD  ──┴── better-sqlite3 + Markdown 文件              │
│       ├── files/Drawings (JSON 场景 + 缩略图)                          │
│       │                                                               │
│       └── dsh/container ── 启动即就绪的 { health, models } 句柄        │
│              │                                                       │
│              └── dsh/dsh-runtime ── 首次 ai.ask 时懒加载               │
│                     ├── dsh/llm-adapter (PiAiAdapter → pi-ai)         │
│                     ├── dsh/skills  (todo-ops、content-ops 等)        │
│                     ├── dsh/tools   (registerDomainTools)             │
│                     └── dsh/endpoints (deepseek/openai/anthropic/ollama/custom)
└───────────────────────────────────────────────────────────────────────┘
                        ▲
                        │ JsonRpcBridge (Unix socket / 命名管道，默认关闭)
                        │
        ┌───────────────┴───────────────┐
        │   外部脚本 / 插件             │
        │   $ echo '{"jsonrpc":"2.0",    │
        │   "id":1,"method":"todo.list", │
        │   "params":{}}' | nc -U …sock  │
        └────────────────────────────────┘
```

### DSH 集成模型

agent 运行时就是真正的 `@deepseek-ai/dsh-*@0.1.5-rc.2`，通过
`npm` 引入、由 [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis)
在 electron 主进程内组装——没有 shim、没有 `dsh` 子进程、没有 stdio 桥。
依赖声明在 `package.json`，版本钉在 `pnpm-lock.yaml`；
`pnpm install` 直接成功，不会撞上 `ERR_PNPM_FETCH_404`。

#### 运行时的两部分

- `src/main/dsh/container.ts` 在主进程启动时就返回一个
  `{ health, models }` 句柄，无需凭据即可回答
  `ai.health` / `ai.models`。
- `src/main/dsh/dsh-runtime.ts` 在第一次 `ai.ask` 时**懒加载**真正的 agent
  循环：动态 `await import('@deepseek-ai/dsh-app-boot')`，解析
  `resources/dsh/cordis.yml`，通过 `registerDomainTools` 注册
  `todo.*` / `content.*` / `drawing.*` 工具，并构造
  `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter`（流式、SSE 解析、
  各家 reasoning delta 都委托给 `@earendil-works/pi-ai`）。第一次
  `ai.ask` 承担 Cordis 冷启动开销，之后所有调用复用同一个单例运行时。

渲染端对这一拆分无感——`window.todoList.ai.*` 的契约保持不变。

#### 三级权限

权限分级由宿主拥有，集中在 `src/shared/permission-tiers.ts`。
`registerDomainTools` 注册的每个工具都会先过 `tierFor(toolName)`：

| 层级         | 示例工具                         | UI                                  |
| ------------ | -------------------------------- | ----------------------------------- |
| auto         | `todo.list`, `content.readBody`  | 静默执行                            |
| notify-undo  | `todo.update`, `content.writeBody` | 8 秒撤销 toast                     |
| block        | `todo.delete`, `content.restoreVersion` | 显式确认弹窗                    |

工具实现见 `src/main/dsh/dsh-runtime.ts` 的 `registerDomainTools`；
外部脚本侧的安全闸见 `docs/adr/006-json-rpc-bridge-capability-token.md`。

### 安全

- 全程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- preload 仅暴露类型化的 `window.todoList.*` 门面；页面代码无法触达原始 `ipcRenderer`。
- `index.html` 与 `capture.html` 均设置 CSP。
- API key 持久化在 OS userData 目录，绝不明文回传渲染进程——`publicView()` 只返回脱敏版本。
- JSON-RPC 桥默认关闭并带访问保护。

### 可访问性

- `src/renderer/styles/global.css` 中所有前景/背景配色满足 WCAG 2.2 AA 对比度。
- 全局 CSS 遵循 `prefers-reduced-motion`。
- 每个可点元素均有 press + commit 状态。
- 活动区域：状态栏（`aria-live="polite"`）、AI 面板（`role="log"`）。

### 许可证

MIT——见 [LICENSE](./LICENSE)。

### 另请参阅

- [AGENTS.md](./AGENTS.md)——给 AI 编码 agent 的简要实现不变式。
- [docs/task-creation-and-storage.md](./docs/task-creation-and-storage.md)——任务创建、AI 意图与存储契约。
- [DEVELOPING.md](./DEVELOPING.md)——本地开发流程、代码布局与约定。
- [docs/architecture.md](./docs/architecture.md)——更深入的架构说明。
- [openspec/changes/todo-list-desktop/](./openspec/changes/todo-list-desktop/)——设计规格。

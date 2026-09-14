# AI待办 · AI-native desktop TODO list

> [English](#english) · [中文](#中文)

---

## English

> An AI-native desktop TODO list built on DeepSeek Harness (DSH) — the agent runtime is wired through the same DSH-shaped interface (Cordis container + tool registry + 3-tier permission gate) so you can drop in a real DSH build later without touching call sites.
> Capture fast, organize freely, write Markdown notes, sketch on Excalidraw, and ask the assistant directly — all inside one Electron app.

![status](https://img.shields.io/badge/status-RC_1.0.0--rc4-yellow)
![electron](https://img.shields.io/badge/electron-33-47848F)
![dsh](https://img.shields.io/badge/DSH-in--process-blue)

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
│                       ▲ window.app.* (contextBridge)                  │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ __app_router__ (validated IPC)
┌─────────────────────── Main Process ───────────────────────────────────┐
│  ipc/router ─ todo/content/drawing/inbox/settings/ai handlers         │
│       │                                                               │
│       ├── db/TodoRepo ─┐                                              │
│       ├── files/MD  ──┴── better-sqlite3 + Markdown files             │
│       ├── files/Drawings (JSON scenes + thumbs)                       │
│       │                                                               │
│       └── dsh/container ── in-process Cordis container                │
│              ├── dsh/tools ── todo.*, content.*, drawing.*            │
│              ├── dsh/skills ── grouped tool bundles                   │
│              └── dsh/client ── DeepSeek API (streaming fetch)          │
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

The agent runtime is wired through a **DSH-shaped interface** — a Cordis container plus a tool registry plus a 3-tier permission gate — but ships as an **in-process shim** (see `src/main/dsh/container.ts`). The shim implements the same tool surface as real DSH so the app is fully usable today.

#### Why a shim, not the published `@deepseek-ai/dsh-base`?

The published rc/next packages on npm (as of 2026-09) reference `@deepseek-ai/dsh-bash-env` and several other packages that **are not on the registry** — `pnpm install` fails with `ERR_PNPM_FETCH_404`. Until that resolves upstream, we ship the shim.

#### Swapping in real DSH later

When the upstream packages become installable:

```bash
pnpm add @deepseek-ai/dsh-base@^0.1.0 @deepseek-ai/cordis@^4
```

Then replace `bootShim()` in `src/main/dsh/container.ts` with `loadRealDsh()` (already written — currently dead code). The rest of the app is unchanged because every call site goes through `DshContainer`.

Three permission tiers, from `src/main/dsh/tools.ts`:

| Tier         | Example tools                    | UI                                  |
| ------------ | -------------------------------- | ----------------------------------- |
| auto         | `todo.list`, `content.readBody`  | runs silently                       |
| notify-undo  | `todo.update`, `content.writeBody` | 8-second undo toast                |
| block        | `todo.delete`, `content.restoreVersion` | explicit confirmation dialog    |

### Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` everywhere.
- Preload exposes only the typed `window.app.*` facade; the raw `ipcRenderer` is never reachable from page code.
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

> 一个 AI 原生的桌面待办应用，构建在 DeepSeek Harness（DSH）之上——agent 运行时复用同一套 DSH 形态接口（Cordis 容器 + 工具注册表 + 三级权限闸），日后接入真实 DSH 构建时无需改动调用方。
> 快速捕获、自由组织、写 Markdown 笔记、在 Excalidraw 上手绘、直接向助手提问——全部在同一个 Electron 应用内完成。

![status](https://img.shields.io/badge/status-RC_1.0.0--rc4-yellow)
![electron](https://img.shields.io/badge/electron-33-47848F)
![dsh](https://img.shields.io/badge/DSH-in--process-blue)

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
│                       ▲ window.app.* (contextBridge)                  │
└───────────────────────┼────────────────────────────────────────────────┘
                        │ __app_router__ (受校验的 IPC)
┌─────────────────────── 主进程 ─────────────────────────────────────────┐
│  ipc/router ─ todo/content/drawing/inbox/settings/ai 处理器          │
│       │                                                               │
│       ├── db/TodoRepo ─┐                                              │
│       ├── files/MD  ──┴── better-sqlite3 + Markdown 文件              │
│       ├── files/Drawings (JSON 场景 + 缩略图)                          │
│       │                                                               │
│       └── dsh/container ── 进程内 Cordis 容器                         │
│              ├── dsh/tools ── todo.*, content.*, drawing.*            │
│              ├── dsh/skills ── 分组工具束                              │
│              └── dsh/client ── DeepSeek API (流式 fetch)              │
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

agent 运行时通过一套 **DSH 形态接口**接入——Cordis 容器 + 工具注册表 + 三级权限闸——但以**进程内 shim** 形式发布（见 `src/main/dsh/container.ts`）。shim 实现了与真实 DSH 相同的工具面，应用今天即可完整使用。

#### 为什么是 shim，而不是已发布的 `@deepseek-ai/dsh-base`？

npm 上的 rc/next 包（截至 2026-09）引用了 `@deepseek-ai/dsh-bash-env` 等若干**不在 registry 上**的包——`pnpm install` 会报 `ERR_PNPM_FETCH_404`。在上游修复前，我们随应用附带 shim。

#### 日后接入真实 DSH

当上游包可安装后：

```bash
pnpm add @deepseek-ai/dsh-base@^0.1.0 @deepseek-ai/cordis@^4
```

然后把 `src/main/dsh/container.ts` 中的 `bootShim()` 换成 `loadRealDsh()`（已写好，目前为死代码）。其余调用方无需改动，因为所有调用都走 `DshContainer`。

三级权限（见 `src/main/dsh/tools.ts`）：

| 层级         | 示例工具                         | UI                                  |
| ------------ | -------------------------------- | ----------------------------------- |
| auto         | `todo.list`, `content.readBody`  | 静默执行                            |
| notify-undo  | `todo.update`, `content.writeBody` | 8 秒撤销 toast                     |
| block        | `todo.delete`, `content.restoreVersion` | 显式确认弹窗                    |

### 安全

- 全程 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- preload 仅暴露类型化的 `window.app.*` 门面；页面代码无法触达原始 `ipcRenderer`。
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

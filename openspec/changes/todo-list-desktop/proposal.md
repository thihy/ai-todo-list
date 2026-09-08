## Why

现有 TODO 工具普遍缺乏 AI 原生集成、Markdown 富内容描述和可视化绘图能力，且大多为 Web 应用，离线与本地系统集成能力弱。我们需要一个**桌面版、AI 原生**的 TODO 工具：让用户能低摩擦地收集 TODO、按项目和优先级整理、对每个 TODO 用 Markdown 记录进展、并能直接绑定 Excalidraw 绘图辅助思考与表达，从而让 AI 真正参与到 TODO 的"采集 → 整理 → 描述 → 可视化"完整闭环中。

## What Changes

- 新增 Electron 桌面应用 `thihy-todolist`（含主进程、preload、渲染进程分层架构）。
- 新增全局快捷键 + 系统托盘的"快速捕获"通道，无干扰地收集 TODO 入收件箱。
- 新增标签、项目、优先级、状态四维分类与多视图（列表 / 看板 / 日历）整理能力。
- 为每个 TODO 关联一个 Markdown 文件作为富内容描述，支持实时预览、版本记录与全文检索。
- 新增 Excalidraw 画布绑定：每个 TODO 可挂载 0~N 张白板图纸，双向链接、缩略图预览。
- 新增 AI 助手面板，支持自然语言新增/改写 TODO、按上下文生成 Markdown 进展、按 TODO 总结与建议下一步。
- 引入本地 SQLite 存储 + 文件系统（Markdown/Excalidraw `.excalidraw` JSON 落盘），支持离线优先。
- 新增 CLI / ACP 风格的"agent 接口"，允许外部 AI Agent 通过 DSH 的 ACP / SDK profile 调用 TODO 增删改查（等同 v1 内置的 MCP 能力，由 DSH 自带）。

## Capabilities

### New Capabilities

- `todo-capture` — 快速捕获 TODO：全局快捷键、托盘菜单、剪贴板监听、AI 解析自然语言。
- `todo-organization` — 整理 TODO：标签、项目、优先级、状态、视图、筛选、排序、批量操作。
- `todo-content` — Markdown 内容：每条 TODO 关联一个 `.md` 文件，支持编辑、预览、版本、全文搜索。
- `excalidraw-integration` — Excalidraw 绘图绑定：每个 TODO 挂载画布、缩略图、双向链接。
- `ai-assistant` — AI 原生能力：自然语言采集、改写、摘要、生成进展草稿、智能打标。
- `desktop-runtime` — Electron 桌面运行时：主进程 / preload / 渲染进程隔离、IPC、自动更新、打包。

### Modified Capabilities

无（项目为全新初始化，无既有规范被修改）。

## Impact

- **新增代码 / 目录**：`src/main/`、`src/preload/`、`src/renderer/`、`src/shared/`、`openspec/`、构建配置（electron-builder / vite）、测试（vitest + playwright）。
- **新增依赖**：Electron、Vite + React、Excalidraw、better-sqlite3、gray-matter、DeepSeek Harness（DSH，作为 Cordis 容器内进程内库：`@deepseek-ai/dsh-base` + `dsh-agent` + `dsh-tools` + `dsh-skill` + `dsh-goal` + `dsh-permission` + `dsh-llm-deepseek`）。
- **新增外部资源**：DeepSeek API Key（用户自填，仅用于 `https://api.deepseek.com/v1`）、系统托盘图标、Excalidraw 自托管资源。
- **数据 / 存储**：用户文档目录下创建 `~/.thihy-todolist/` 包含 `db.sqlite`、`todos/*.md`、`drawings/*.excalidraw`。
- **安全模型**：渲染进程开启 `contextIsolation`，主进程通过受限 IPC 暴露能力；AI 请求走主进程代理，密钥不入渲染层；DSH 在同一主进程内以 Cordis 容器持有危险 tool 的权限策略。
- **跨平台**：Windows / macOS / Linux 一套代码，差异点收敛在 `desktop-runtime`。
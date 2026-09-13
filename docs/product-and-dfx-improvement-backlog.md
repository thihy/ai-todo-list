# 产品、体验与 DFX 改进任务清单

> 状态：候选任务池，不代表任何任务已经实现。
>
> 用途：为产品规划、技术设计和开发 Agent 分派提供统一入口。
>
> 原则：每个任务必须单独分析、单独实施、单独验收；不得把本清单整体作为一次开发任务。

## 1. 当前产品基础

当前源码已经具备以下可复用能力：

- SQLite 任务事实来源与每任务稳定目录关联；
- 普通任务、子任务、状态、优先级、截止日期、标签与 `plannedFor`；
- Today 规划引导、计划提醒、归档、软删除与恢复；
- 数字进度、进度时间线、富文本进展文档、Markdown 笔记；
- Excalidraw 绘图、缩略图与附件；
- FTS 任务搜索与统计视图；
- AI 会话、流式回答、附件、人机问答、审批和任务工具；
- Core 与 AI 独立启动状态；
- 类型化 IPC facade、通道白名单和数据变化广播；
- 自动更新、全局快速捕获、托盘和本地 JSON-RPC bridge。

本清单优先补齐“捕获 → 澄清 → 安排 → 执行 → 复盘 → 沉淀”闭环，而不是无边界增加字段。

## 2. 优先级总览

| 优先级 | 编号 | 名称 | 类型 | 预期价值 | 预计复杂度 |
| --- | --- | --- | --- | --- | --- |
| P0 | DX-01 | CodeGraph 与 Agent 代码探索基线 | DevEx | 降低误判调用链和遗漏影响面的概率 | 低 |
| P0 | REL-01 | 数据备份、恢复与健康检查 | 可靠性 | 降低长期使用中的数据损失风险 | 中高 |
| P0 | UX-01 | AI 初始化失败后原地重试 | 体验/可靠性 | AI 故障不再要求重启应用 | 中 |
| P0 | PRODUCT-01 | 今日驾驶舱 MVP | 产品/体验 | 形成每日计划与执行闭环 | 中高 |
| P0 | ARCH-IPC-01 | IPC 运行时校验与统一错误分类 | 安全/架构 | 建立稳定进程边界和错误契约 | 中高 |
| P1 | UX-02 | 现在做什么专注模式 | 产品/体验 | 降低执行过程中的注意力切换 | 中 |
| P1 | AI-01 | AI 高风险创建预览与统一撤销 | AI/安全/体验 | 提升 AI 操作可信度和可恢复性 | 中高 |
| P1 | SEARCH-01 | 搜索结果直接行动与 AI 上下文 | 产品/体验 | 提升大任务库中的操作效率 | 中 |
| P1 | QUALITY-01 | 任务健康检查与修复建议 | 产品/质量 | 主动发现过期、停滞和状态矛盾 | 中 |
| P1 | OBS-01 | 可导出的隐私安全诊断包 | 可观测性 | 降低用户现场问题的定位成本 | 中 |
| P1 | SEC-01 | JSON-RPC bridge 默认关闭与访问保护 | 安全 | 收紧本地外部调用面 | 中高 |
| P1 | PERF-01 | 性能基线与大数据量压测 | 性能 | 用数据决定虚拟化、分页和懒加载 | 中 |
| P1 | ARCH-UI-01 | AI 面板按状态与职责拆分 | 可维护性 | 降低复杂状态交叉和回归概率 | 中高 |
| P2 | PRODUCT-02 | 重复任务 | 产品 | 支持习惯和周期工作 | 高 |
| P2 | PRODUCT-03 | 任务依赖与阻塞原因 | 产品 | 让 blocked 状态具有真实语义 | 高 |
| P2 | PRODUCT-04 | 智能收件箱 | 产品/AI | 将碎片输入安全转成任务候选 | 中高 |
| P2 | PRODUCT-05 | 保存筛选器与智能列表 | 产品 | 支持稳定的个性化工作视图 | 中 |
| P2 | PRODUCT-06 | 任务模板 | 产品 | 复用固定任务、文档和子任务结构 | 中高 |
| P2 | PRODUCT-07 | 周复盘 | 产品/AI | 形成长期反馈与调整循环 | 中 |
| P3 | SEARCH-02 | 本地语义搜索 | AI/搜索 | 跨任务、文档和会话检索 | 高 |
| P3 | AI-02 | AI 记忆控制台 | AI/隐私 | 让 AI 记忆来源和删除行为透明 | 高 |
| P3 | AUTOMATION-01 | 受控工作流自动化 | 自动化 | 根据状态变化触发后续动作 | 高 |

## 3. P0 独立任务

### DX-01 CodeGraph 与 Agent 代码探索基线

#### 目标

让开发 Agent 在 CLI、MCP、沙箱权限和索引状态不同的环境中，都能稳定执行代码图谱探索，并在不可用时可靠回退到源码搜索。

#### 当前问题

- 仓库已有 `.codegraph/` 索引，但全局 CLI 可能位于工作区外并被 Agent 沙箱拒绝执行。
- 全局安装 CLI 不代表当前 Agent 会话已经加载 CodeGraph MCP 工具。
- 宽泛自然语言查询可能只召回少数符号。
- CodeGraph 不能完整发现 IPC 字符串、Electron 事件、React 闭包、动态导入、YAML 和 CSS 关系。

#### 必须阅读

- `AGENTS.md`
- `package.json`
- `DEVELOPING.md`
- `.gitignore`
- 当前实际存在的 CodeGraph 项目配置

#### 预计修改范围

- `AGENTS.md`
- `DEVELOPING.md`
- `package.json`（仅在确认项目本地调用方式可行时）
- 可选新增 `docs/code-exploration.md`

#### 实施要点

1. 诊断 CLI 路径、版本、索引状态和 MCP 暴露状态。
2. 优先建立不依赖特定 NVM 全局路径的调用方式。
3. 文档化 `status → sync → context → node/impact → rg → affected` 流程。
4. 提供当前仓库的真实查询示例。
5. 明确索引文件、WAL、锁文件和机器绝对路径不得提交。
6. CodeGraph 不可用时直接使用 `rg` 和人工调用链分析，不中断任务。

#### 验收

- 新 Agent 能判断 CLI、MCP和索引分别是否可用。
- 文档至少包含任务创建、AI 请求、稳定任务目录三条真实链路示例。
- `.codegraph/` 索引未进入 Git 变更。
- 未修改应用业务代码。

### REL-01 数据备份、恢复与健康检查

#### 目标

为 SQLite、任务目录、附件和文件投影提供安全、可验证、可恢复的数据保护能力。

#### 当前问题

- SQLite 是事实来源，文件是耐久投影，部分文件写入是 best-effort。
- 直接热拷贝 SQLite 主文件可能遗漏 WAL 中的数据。
- 当前缺少面向用户的完整备份、恢复预检和一致性报告。

#### 必须阅读

- `AGENTS.md`
- `docs/task-creation-and-storage.md`
- `src/main/db/schema.ts`
- `src/main/db/todo-repo.ts`
- `src/main/files/task-directories.ts`
- `src/main/files/documents.ts`
- `src/main/files/drawings.ts`
- `src/main/files/inbox.ts`
- `src/main/settings/store.ts`
- `docs/operations.md`

#### 预计修改范围

- 新的主进程 backup/health 服务
- 对应 IPC schema、preload facade 和 handlers
- 设置界面的数据管理区域
- 必要的运维文档

#### 实施要点

1. 使用 SQLite 支持的一致性备份机制，不直接复制运行中的数据库主文件。
2. 备份任务根目录，并生成不含敏感信息的 manifest。
3. 恢复前验证格式、schema 版本、关键文件和路径安全。
4. 恢复时先落到临时目录验证，再执行可回滚切换。
5. 健康检查只报告孤立文件，默认不自动删除。
6. 区分可重建投影与不可重建的用户附件。
7. 修复前自动生成恢复点。

#### 非目标

- 不做云同步。
- 不做多设备冲突合并。
- 不改变 SQLite 事实来源原则。

#### 验收

- 运行中备份得到一致快照。
- 损坏或不兼容备份不会覆盖当前数据。
- 恢复失败后原数据仍可使用。
- 健康检查能发现缺失附件、非法目录关联和孤立投影。
- 日志和报告不泄漏 API Key 或不必要的绝对路径。

### UX-01 AI 初始化失败后原地重试

#### 目标

让 AI 启动失败、配置修正或临时网络故障后，可以在当前应用会话中安全重试，无需退出应用。

#### 当前问题

- Core 与 AI 已有独立启动状态。
- AI 失败不会影响任务管理，这是正确边界。
- AI 进入 `failed` 后目前没有会话内重试路径。

#### 必须阅读

- `src/main/startup-state.ts`
- `src/main/dsh/container.ts`
- `src/main/dsh/dsh-runtime.ts`
- `src/main/ipc/ai-handlers.ts`
- `src/shared/ipc-schema.ts`
- `src/shared/todo-list-api.ts`
- `src/preload/index.ts`
- `src/renderer/panes/AIPane.tsx`
- `src/renderer/dsh/provider-status.ts`
- `src/renderer/components/SettingsModal.tsx`

#### 实施要点

1. 明确 runtime 的 `start/retry/dispose` 生命周期。
2. 增加幂等、单飞的 AI retry IPC。
3. 重试期间状态为 `loading`，成功进入 `ready`，失败返回脱敏错误。
4. 防止并发重试、旧 runtime 泄漏和重复事件监听。
5. 保留 AI 输入草稿和现有会话列表。
6. 配置修正后允许立即重试。

#### 验收

- 连续快速点击只发生一次初始化。
- 首次失败后可在当前进程成功恢复。
- 重试失败不影响任务管理。
- 不产生重复流事件、重复工具注册或残留 pending 请求。

### PRODUCT-01 今日驾驶舱 MVP

#### 目标

把 Today、提醒、进度、子任务和 AI 串成“开始一天—执行—结束一天”的最小闭环。

#### 当前问题

- `plannedFor`、规划引导、提醒、统计和进度日志已经存在。
- 这些能力目前彼此较独立，缺少统一的每日执行入口。

#### 必须阅读

- `src/shared/todo-types.ts`
- `src/main/db/todo-repo.ts`
- `src/renderer/components/PlanGuideModal.tsx`
- `src/renderer/panes/TodoListPane.tsx`
- `src/renderer/panes/TodoEditorPane.tsx`
- `src/renderer/panes/StatsPane.tsx`
- `src/renderer/layout/Sidebar.tsx`
- `src/main/notification/plan-reminder.ts`
- `src/main/dsh/dsh-runtime.ts`
- `resources/dsh/cordis.yml`

#### MVP 范围

1. 开始一天：列出昨天未完成、今天截止、已阻塞和高优先级候选。
2. 用户选择 3～5 个今日任务；允许超出但给出超载提示。
3. Today 首页突出推荐的下一项任务。
4. 执行中可完成、暂停、设为阻塞或记录一句进展。
5. 结束一天时处理未完成项：移到明天、退回待安排、保持阻塞或取消。
6. AI 只提供排序、拆分和复盘建议；实际写入必须复用现有任务服务。

#### 非目标

- 不做完整日历排程。
- 不做工时计费。
- 不引入 Project 实体。
- 不让 AI 未经确认批量改变任务。

#### 验收

- `dueAt` 与 `plannedFor` 语义保持独立。
- 所有父任务 ID 来自真实任务查询。
- 切换本地日期后 Today 归属正确。
- 结束一天不会静默丢失未完成任务。
- AI 不可用时仍能手动完成全部流程。

### ARCH-IPC-01 IPC 运行时校验与统一错误分类

#### 目标

让类型声明、运行时校验、preload facade、handler 注册和错误展示形成一份可检查的进程边界契约。

#### 当前问题

- TypeScript 类型不会校验运行时 payload。
- 当前路由能拒绝未知通道，但 handler 异常可能被归并为通用错误。
- 新通道仍需要跨多处维护。

#### 必须阅读

- `src/shared/ipc-schema.ts`
- `src/shared/channels.ts`
- `src/shared/todo-list-api.ts`
- `src/preload/index.ts`
- `src/main/ipc/router.ts`
- 所有 `src/main/ipc/*-handlers.ts`

#### 实施要点

1. 建立请求运行时 schema，覆盖字符串长度、数组长度、ULID、时间和数据体大小。
2. 定义稳定错误分类：参数、未就绪、未找到、冲突、权限、基础设施和未知错误。
3. 不把原始内部错误直接返回 renderer。
4. 增加启动时契约完整性检查。
5. 保持 renderer 不接触原始 `ipcRenderer`。
6. 分阶段迁移，避免一次性重写全部 handler。

#### 验收

- 非法 payload 在进入领域逻辑前被拒绝。
- 声明未注册和注册未声明都能被检测。
- 错误消息不包含密钥、堆栈或敏感绝对路径。
- 现有 preload API 对调用方保持兼容。

## 4. P1 独立任务

### UX-02 现在做什么专注模式

只展示当前任务、下一子任务、截止日期、进度和阻塞信息；提供完成、暂停、记录进展、询问 AI 下一步操作。第一版不做复杂计时系统。

主要入口：`TodoListPane.tsx`、`TodoEditorPane.tsx`、`ProgressView.tsx`、`Statusbar.tsx`、任务导航 hooks。

验收重点：离开专注模式不丢状态；完成后下一任务选择可解释；AI 不可用不影响手动模式。

### AI-01 AI 高风险创建预览与统一撤销

普通单任务创建保持快速；多任务、父子任务、含日期或批量变更先展示结构化预览。实际写入继续调用现有 `todo.create/update`，不建立第二套写路径。撤销必须基于真实变更记录，不依赖模型反向猜测。

主要入口：`Composer.tsx`、`AIPane.tsx`、`AiCreateTaskMessage.tsx`、DSH 工具注册、权限分层和 todo handlers。

### SEARCH-01 搜索结果直接行动与 AI 上下文

在搜索结果中支持加入今天、改状态、改优先级、批量加标签、打开任务，以及把选中结果作为 AI 明确上下文。批量操作必须复用 `todo.batchUpdate` 或领域服务。

主要入口：`CommandPalette.tsx`、`TodoListPane.tsx`、`useTodoListApi.ts`、`todo.search`、`app.focus`。

### QUALITY-01 任务健康检查与修复建议

优先使用确定性规则识别：长期 doing 无进展、已过期、blocked 无说明、父任务完成但子任务未完成、progress/status 矛盾、Today 超载和长期无活动。AI 只负责解释和建议，不充当事实检测器。

第一版只报告和导航，不自动批量修复。

### OBS-01 可导出的隐私安全诊断包

导出应用版本、系统版本、schema 版本、启动阶段耗时、provider 类型、脱敏日志、数据规模和健康检查摘要。默认排除任务正文、附件、AI 会话、API Key 和用户绝对路径。

主要入口：`logger.ts`、`startup-state.ts`、`schema.ts`、设置界面和新的 diagnostics 服务。

### SEC-01 JSON-RPC bridge 默认关闭与访问保护

将 bridge 改为显式启用，加入本地 capability token、请求大小限制、方法权限、速率限制和脱敏审计。Windows named pipe 应核查用户级访问限制。

主要入口：`src/main/sdk/bridge.ts`、`src/main/sdk/sdk.ts`、`src/main/index.ts`、设置存储。

### PERF-01 性能基线与大数据量压测

建立冷启动、Core ready、首列表可交互、首次 AI、搜索延迟以及 1k/10k/50k 任务规模下的查询和渲染基线。先形成数据报告，再决定分页、虚拟化、缓存或懒加载方案。

必须核实文档中关于 `react-window` 的描述；当前 `package.json` 未声明该依赖，不能把文档描述当作已实现事实。

### ARCH-UI-01 AI 面板按状态与职责拆分

按变更原因拆分会话索引、活动会话、AI invocation、人机交互、附件、外部请求队列和展示组件。不得只做机械 JSX 拆文件，也不得在拆分任务中改变用户行为。

主要入口：`src/renderer/panes/AIPane.tsx` 及其现有 hooks、DSH UI 组件。

## 5. P2/P3 产品候选

### PRODUCT-02 重复任务

需要先定义模板与实例、下一次生成时机、修改单次或修改系列、时区、补生成、归档和删除语义。不得直接复制旧任务的历史、附件或完成状态。

### PRODUCT-03 任务依赖与阻塞原因

增加明确依赖关系、防环校验和解除依赖后的提示。不要把 `parentId` 同时当作结构关系与依赖关系。

### PRODUCT-04 智能收件箱

把剪贴板、快速捕获和文本附件解析成候选任务。解析和持久化必须分离，用户确认后才写入；普通 AI 对话不能因文本像任务而自动创建。

### PRODUCT-05 保存筛选器与智能列表

保存状态、标签、日期、优先级和文本条件组合。需要区分一次性 UI 筛选和持久智能列表，不引入隐式 Project。

### PRODUCT-06 任务模板

允许复用标题模式、默认字段、文档骨架和子任务结构。必须明确附件、进度历史、绘图和日期是否复制；默认不复制历史数据。

### PRODUCT-07 周复盘

基于真实统计、状态变更和进度日志生成复盘候选；用户确认后再保存。AI 不应把缺失数据编造成结论。

### SEARCH-02 本地语义搜索

在 FTS 之外增加可选向量索引，覆盖任务、笔记、进展文档和会话。必须处理索引重建、模型变更、隐私开关和离线降级。

### AI-02 AI 记忆控制台

展示每条记忆的内容、来源、创建时间、最后使用时间和删除入口。读取与删除应复用已有 AI memory API，避免增加第二套记忆存储。

### AUTOMATION-01 受控工作流自动化

允许由状态、日期或任务事件触发提醒或后续动作。必须有循环检测、幂等键、执行历史、权限分层和全局熔断开关。

## 6. 统一架构约束

所有任务都必须遵守：

1. SQLite 是事实来源，文件是用户可见的耐久投影。
2. 任务文件必须通过 `TaskDirectoryStore` 的稳定关联解析。
3. 不从任务标题重复推导存储目录。
4. `dueAt` 与 `plannedFor` 语义独立。
5. `Project` 只是遗留字段，不得作为新产品实体使用。
6. 表单创建直接调用 `todo.create`，不调用 AI。
7. AI 创建必须显式携带 `intent: 'create-task'`。
8. 普通 AI 对话不得因为文本像任务而自动创建任务。
9. 不得发明 `parentId` 或其他任务 ID。
10. 新功能优先复用现有 Repo、Store、IPC 和 DSH 工具。
11. 新旧路径过渡期只能有一个写入事实来源。
12. 错误、日志和诊断信息不得泄漏 Key、内部堆栈或用户隐私。

## 7. 统一代码探索要求

每个任务先执行：

```text
AGENTS.md
  ↓
git status --short
  ↓
CodeGraph status/sync/context/node/impact（可用时）
  ↓
rg 补查 IPC、事件、闭包、动态 import、YAML、CSS 和文件路径
  ↓
人工阅读真实调用链
  ↓
记录现状、根因、范围和非目标
```

业务调用链至少检查：

```text
Renderer
  → preload facade
  → IPC registry/channel
  → main handler
  → Repo/Service
  → SQLite/File projection
  → app:data-changed 或领域事件
  → renderer hook/state
  → UI
```

AI 任务额外检查：

```text
AIPane
  → ai.ask
  → ai-handlers
  → DSH runtime
  → tool
  → Repo/Store
  → stream/history projection
  → AIPane
```

## 8. 统一验证要求

按风险选择验证，但最低要求是：

```bash
pnpm typecheck
pnpm build
```

此外：

- 运行与修改范围直接相关的现有测试；
- 用 `git diff --check` 检查格式问题；
- 用 `git diff` 核对没有夹带其他任务；
- 只有实际执行过的手工操作才能声明为通过；
- 数据与存储任务必须验证失败路径和恢复路径；
- IPC/安全任务必须验证非法输入；
- 性能任务必须保存可重复的环境、数据量和测量口径。

## 9. 推荐实施顺序

```text
DX-01 代码探索基线
   ├── REL-01 数据保护
   ├── UX-01 AI 原地重试
   └── ARCH-IPC-01 IPC 契约

PRODUCT-01 今日驾驶舱
   ├── UX-02 专注模式
   ├── QUALITY-01 任务健康
   └── PRODUCT-07 周复盘

ARCH-IPC-01
   ├── SEC-01 Bridge 防护
   ├── AI-01 AI 预览与撤销
   └── AUTOMATION-01 工作流自动化
```

P2/P3 项目需要单独产品决策，不应在 P0/P1 任务中顺带实现。

# AIPane 渲染升级方案 — 对齐 DSH 协议层

## Context

用户审视当前 AIPane 后指出「自实现的渲染比较低级」。经 DSH 源码调研发现,DSH
并未提供 React UI 渲染层(`@deepseek-ai/dsh-*` 全是协议 + runtime,无 `.tsx` 组件),
但提供了**完整的协议层**,而我们的渲染层**正在反复重新实现这些协议**:

1. `BlockAssembler` — DSH 官方增量 chunk → blocks → Message 累积器(`@deepseek-ai/dsh-llm`)
2. `StreamChunk` — 统一的流协议(block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish)
3. `ContentBlock` — 合并可扩展的块类型表(text / reasoning / image / tool-call / tool-result)
4. `ToolCallView` / `ToolResultView` — 工具自描述的渲染意图(generic / terminal / diff / search / read / web)

我们的实现:每个协议都重新实现了一份—— 而且做得更糙。

## DSH 协议一览

### `StreamChunk`(我们已经在线发出过这个形状,在 `llm-adapter.ts`)

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id; name?; argumentsDelta }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState? };
```

### `BlockAssembler`(`@deepseek-ai/dsh-llm/assembler`)

```ts
class BlockAssembler {
  push(chunk: StreamChunk): void;
  blocks(): ContentBlock[];                    // 按 stream 顺序的已合并块
  interruptedBlocks(): ContentBlock[];         // 中断流可安全终结的前缀
  get usage(): TokenUsage | undefined;
  get finish(): FinishReason;
  message(source?: MessageSource): Message;    // 返回冻结的 assistant Message
}
```

### `ContentBlockMap`(合并可扩展)

| type           | shape                                                         |
| -------------- | ------------------------------------------------------------- |
| `text`         | `{ type: 'text', text }`                                      |
| `reasoning`    | `{ type: 'reasoning', text }`                                 |
| `image`        | `{ type: 'image', attachment: ImageAttachmentRef }`           |
| `tool-call`    | `{ type: 'tool-call', id, name, arguments }`(arguments 是原始 JSON 串) |
| `tool-result`  | `{ type: 'tool-result', toolCallId, content: ContentBlock[], isError? }` |

### `ToolDefinition.presentCall` / `presentResult`(`@deepseek-ai/dsh-tools`)

工具可声明「我应该这样被渲染」,无需 UI 按工具名硬编码:

| card            | 渲染意图                                                              |
| --------------- | --------------------------------------------------------------- |
| `generic`       | 默认卡片:title + kind 图标 + rawInput + locations               |
| `terminal`      | 命令执行卡片:title + cwd + output + exitCode                    |
| `diff`          | 文件编辑:title + diffs (FileDiff[]) + 行号 follow-along         |
| `search`        | 搜索结果(grep / glob):matches-by-file 或 path list + truncated |
| `read`          | 文件阅读:lines (ReadFileLine[]) + offset + totalLines + lang  |
| `web`           | 网络抓取:sources (URL + title + snippet) + statusCode + truncated |

## 当前实现的「低级」盘点

| # | 维度 | 当前(自实现) | DSH 协议层 | 差距 |
| - | ---- | ------------ | ---------- | ---- |
| 1 | 流累积 | `tokens.map(...).join('')` 拼字符串 | `BlockAssembler` 增量合并 `ContentBlock[]` | **丢块边界** —— 同一消息里 thinking → tool-call → text → tool-call → text 的边界被抹掉 |
| 2 | 消息形状 | `{ user, reasoning, assistant, tools[] }` 4 个独立字段 | `Message { content: ContentBlock[] }` | **不支持交错块** —— reasoning 在 tool-call 中间被强行独立列 |
| 3 | 工具结果 | `<pre>{JSON.stringify(args, null, 2)}</pre>` | `ToolResultView` 按 `card` 分发(generic/terminal/diff/search/read/web) | 不知道 todo.create 改了啥、todo.list 拉了哪些、读的是哪一行的代码 |
| 4 | Markdown | 每次 token 都全量重 parse | 累积到最后块边界再 parse;开放块用原始文本 + 光标 | **流式无谓开销** —— 长回答 O(n²) parse |
| 5 | 代码高亮 | `marked` 默认(无语法着色) | `lang` 字段已就位(`ReadResultView.lang`) | 代码块黑白一片 |
| 6 | 图片 | 无 | `ImageBlock { attachment: ImageAttachmentRef }`(`@deepseek-ai/dsh-attachment` 持久化) | 模型无法发图;我们也接不住 |
| 7 | 操作按钮 | 无 | (DSH 不规定,但属该层该补) | 无法「复制 / 重新生成 / 编辑」AI 答复 |
| 8 | 中断态 | 拼字符串尾巴截断 | `interruptedBlocks()` 已正确分清可终结前缀 | 中断后 reasoning 偶尔泄漏 |
| 9 | 错误态 | 整块替换 assistant 文本 | `finish { kind: 'error' \| 'aborted' }` 独立通道 | 错误信息混在最终文本里 |
| 10 | 工具注册 | 走自己的桥(`ai-handlers.ts` 手动分发) | `ToolRuntime.register(definition)` + `presentCall`/`presentResult` | 没法让工具声明自己的渲染意图 |

## 升级路径(分阶段独立交付)

### Phase A — 协议层端到端对齐(核心)

把 IPC 形状从 `AIStreamEvent` 改成 `StreamChunk`,renderer 用 `BlockAssembler` 累积。

**改动**:

1. **shared 层**:把 `StreamChunk` / `ContentBlock` 类型从 `@deepseek-ai/dsh-llm` 直接 re-export,不再维护平行 `AIStreamEvent`。理由:DSH 是事实标准,我们重写一份既不一致又会漂移。

2. **dsh-runtime**:`runTurn` 的 `onEvent` 直接吐 `StreamChunk`(已经是这个形状,只在 `ai-handlers.ts` 里被二次扁平化)。需要新增一个工具:把 `BlockAssembler` 套在 stream 上,每 `push(chunk)` 后立即 yield 给 renderer。

3. **ai-handlers**(`src/main/ipc/ai-handlers.ts`):
   - `send({ type: 'token', ... })` → `send({ type: 'text-delta', ... })`
   - `send({ type: 'reasoning', ... })` → `send({ type: 'reasoning-delta', ... })`
   - `send({ type: 'toolCall', ... })` → 拆成 `tool-call-delta` + `block-end { block: tool-call }` + `block-end { block: tool-result }`(DSH 协议)
   - 移除 `AIDoneEvent.content`(协议里 `finish` 不带内容,内容由 blocks 累出)
   - 保留 `costUsd` 计算,但通过 usage 块附带(DSH 协议已含 `TokenUsage`)

4. **useAiStream**(`src/renderer/hooks/useAiStream.ts` 等):事件按 `convId + invocationId` 分流后,直接喂给 `BlockAssembler` 实例,而不是 `.filter().map().join()`。

5. **AIPane**:
   - `Turn` 类型从 `{ user, reasoning, assistant, tools[] }` 改成 `{ id, role: 'user' | 'assistant', content: ContentBlock[], status }`。
   - `TurnView` 改为渲染 `ContentBlock[]` —— 每个 block 用对应组件(`TextBlockView` / `ReasoningBlockView` / `ToolCallBlockView` / `ToolResultBlockView` / `ImageBlockView`)。
   - `ToolCallBlockView` 接收 `ToolCallView | ToolResultView`(从 `presentCall`/`presentResult` 拿),不再按工具名硬编码。

6. **历史持久化**:`HistoryTurn` 形状同步升级为 `Message[]`(从 JSONL 读出 `content: ContentBlock[]`,不再是 `{ type: 'assistant'; text; reasoning? }` 平的)。需要 `dsh-session-persistence-jsonl` 的 message 序列化配合 —— 可能要加 `BlockAssembler` 的对应反序列化路径,或写一个 `Message → blocks → JSON` 工具。

### Phase B — 工具声明渲染意图

让我们 12+ 个 `todo.*` / `content.*` / `drawing.*` / `document.*` 工具按 DSH `presentCall` / `presentResult` 注册:

- `todo.create` / `todo.update` / `todo.delete`: pending `generic { kind: 'edit' }`,result 显示受影响 todo 的标题 + ID
- `todo.list` / `todo.search`: result 显示命中条数 + 第一条预览
- `content.writeBody`: pending `generic { title: '更新 <任务名> 正文' }`,result 显示改了多少行
- `content.restoreVersion`: result 显示版本号 + 时间
- `drawing.save`: pending `generic { kind: 'edit' }`,result 显示 drawingId
- `drawing.delete`: pending `generic { kind: 'delete' }`
- `document.create` / `document.remove` / `document.rename`: pending `generic { title: '<op> <kind> 文档' }`
- `progress.log`: pending `generic { title: '记录进度 <N>%' }`
- `inbox.attach` / `attachBlob` / `remove`: pending `generic { title: '附加 <name>' }`
- `conversation.rename` / `archive` / `unarchive` / `delete`: pending `generic { kind: 'edit' }`

由于我们不走 DSH 的 `ToolRuntime`(走的是 `ai-handlers.ts` 自建桥),需要:

- **Option X(优)**:把工具注册迁到 DSH `ToolRuntime.register(definition)`,在 `dsh-runtime.ts` 里加一个 `registerTodoTools()`。`ai-handlers` 改得很轻,只做 IPC。
- **Option Y(过渡)**:保留自建桥,但每个 tool handler 返回 `{ value, content, presentationMeta }`,`ai-handlers` 透传到 renderer,renderer 调 `presentCall`/`presentResult` 模拟器生成 `ToolCallView`/`ToolResultView`。成本:renderer 里也要维护一份呈现层。

**建议 Option X**。这是真正的"用 DSH 协议"。

### Phase C — Markdown / 代码高亮 / 操作按钮

1. **Markdown 增量渲染**:开放 text 块在最终渲染前用 `<MarkdownLive text={...}/>`(每 token 不重 parse,只在结束时 parse 一次);最终块(已 `block-end`)用 `<Markdown done>`。
2. **代码块语法高亮**:Shiki(`shiki` 包,~250KB 静态 + 主题),按 `ReadResultView.lang` 触发,折叠长代码块。
3. **消息操作**:复制 / 重新生成 / 编辑三条;hover 时显示。
4. **错误 / 中断态**:`finish { kind: 'error' }` 单独红条;`aborted` 显示"已停止"+ 提示"继续提问可重新发起"。

### Phase D — 图片块端到端(可选,本期可不发)

`ImageBlock { attachment: ImageAttachmentRef }` → renderer 读 `@deepseek-ai/dsh-attachment` 的本地路径,用 `<img src="attachment://...">`。需要 main 暴露 `attachment://` 协议。需要模型支持多模态输出(DSH 当前 production adapters text-only),但先打好管道等 vision-capable 模型接入。

## 风险

| 风险 | 缓解 |
| ---- | ---- |
| JSONL 历史不兼容 | 增量迁移:旧 JSONL `turns[]` 平字段,新 JSONL `messages[]` + `ContentBlock[]`。启动时检测 schema,逐 conversation 转译 |
| 工具注册迁移 Option X 工期长 | Phase A 完成先把协议层铺好,Option Y 作过渡,Phase B 单独排期 |
| Markdown 增量引擎复杂度 | 先做"末尾块拼接 + 光标"的简单方案,Shiki 延后 |
| StreamChunk 类型变动大 | `git mv` 单原子提交,renderer / main 同步改 |

## 验收(Phase A)

- 发送一条带 reasoning + tool-call + text 的 prompt,记录到的 stream 顺序与 DSH 协议一致
- `BlockAssembler` 累积出 `ContentBlock[]`,AIPane 按块类型分发渲染
- 中断 / 错误态分开,不污染最终文本
- 旧 JSONL 仍可读(降级路径)

## 验收(Phase B)

- `todo.create` 工具卡片显示"创建了 N 个任务:<标题>"
- `todo.list` 显示"找到 N 个",首条标题可点击跳转
- 卡片标题、图标、操作按钮统一,不依赖工具名硬编码

## 不做

- ❌ 不引入 React Markdown 第三方渲染器(Streamdown / react-markdown 等)。Shiki 只在 `<pre>` 子节点用,外层 marked 已够
- ❌ 不做图片生成 / 多模态输出(DSH 当前 production adapters text-only)
- ❌ 不做 message 分支(threading / variants / edit & regenerate 完整 ChatGPT 范式)—— 单独议题
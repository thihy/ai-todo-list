# DSH component adoption

> **状态：部分实施 / 进行中。** 本文件记录「按组件逐步替换为 DSH UI 原始组件」的实施增量。
>
> 验收状态以来源为准；不要把这里的描述当作已完成的功能清单。当前事实以 [`docs/architecture.md`](../architecture.md) §6、ADR-003，以及 PR 提交链为准。
>
> 已落地（按本文件叙述）：
> - `AIComposer` / `PendingQuestionCard` / `PendingApprovalCard` 等适配器已就位，UI 由宿主持有。
> - `AssistantMarkdown` 与 ToolRow 已接入，呈现元数据贯通实时流与历史回放。
>
> 仍待落地（在本文件中以「next increments」形式描述）：
> - 把 DSH session / input / slot 服务接进 Electron host。
> - 注册 official conversation UI slots 并端到端验证 InputBar。
> - 适配剩余工具槽位。

## Integration findings

- `dsh-client-ui-primitives` publicly exports Cordis-free React components,
  including Button, DisclosureRow, MarkdownText and RiskConfirmation.
- `dsh-client-ui-conversation/client` exports assembly services and contracts.
  InputBar is an internal slot implementation, not a named public export.
  It requires session/input stores, input actions, a Lexical editor binding,
  upload services, localization and slot rendering. Integrating the complete
  composer requires these services to be connected to the Electron host.
- `dsh-client-ui-tool` AskQuestionCard displays a transcript; it is not an
  interactive question form. Do not substitute it for the pending form.
- Locally copied ToolRow and ReasoningRow are source reuse, not automatically
  upgraded package components.

## First increment

Use the public DisclosureRow customization props to display full question
titles and explicit detail text. Keep the body scrollable with actions visible.
Use public Button components for question actions. Preserve selections and
input blocking during submission; show failures for retry. Skipping submits
each question with an empty selection, respecting the current IPC contract.

The current composer remains host-owned. Full InputBar adoption is pending
session/input/slot service integration; it is not completed by this increment.

The host composer now lives behind `AIComposer`, a single adapter boundary.
It consumes DSH `Button`, icon and `ComposerBlock` APIs while exposing the
existing Electron callbacks. A later full InputBar integration replaces this
component instead of modifying the whole AI pane.

Pending structured questions now live behind `PendingQuestionCard`. The
interactive form uses the public DSH Button, Pill and DisclosureRow primitives;
the package's AskQuestionCard remains reserved for settled transcript display.
Pending approvals likewise live behind `PendingApprovalCard`, which delegates
the interaction to DSH RiskConfirmation.

Assistant prose is rendered through the vendored upstream AssistantMarkdown
component. Domain tool rows and the throttled reasoning adapter remain separate
so interleaved event order and high-frequency reasoning updates stay intact.

The `tool/result.meta` presentation payload is now preserved through both the
live stream and history replay. DSH `web_search` and `web_fetch` results use the
vendored ToolRow's native WebBlock, including structured sources, status code
and truncation state; malformed metadata still falls back to generic output.

The renderer no longer truncates the active invocation with a global 200-event
slice. It retains the complete active stream and bounds only residue from older
invocations. Event-to-turn projection is a pure, tested DSH adapter, while
`AssistantTurnContent` owns the ordered ReasoningRow, ToolRow and
AssistantMarkdown composition. This removes stream reduction and component
dispatch from the already-large AIPane without changing the wire protocol.

The next increment uses official Button components for attachment, send and
stop, and the official ComposerBlock type for the host blocking reason. This
is contract/primitive reuse, not installation of the DSH input service.
Question and approval timeout notifications now reach the renderer and clear
only the matching pending request. Chinese IME confirmation does not submit.

## Next increments

1. Bind DSH session input and composer-block services to IPC and file picking.
2. Register official conversation UI slots and verify InputBar end to end.
3. Adapt conversation assembly and remaining tool slots; retire duplicate
   reducers only after live/history parity, cancellation and tool ordering are
   verified. WebBlock is already connected through durable presentation meta.
4. Record upstream revisions/local differences for retained source copies.

The older aipane-rendering-upgrade.md is historical: its claims that DSH has
no React UI and that this app does not use the DSH tool registry are obsolete.

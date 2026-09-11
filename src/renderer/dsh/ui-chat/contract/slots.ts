/** Local re-export shim — the vendored chat components import `ChatNodeOwnerProps`
 *  and `ChatViewSlotProps` from `../contract/slots.ts`. The real ui-chat
 *  `contract/slots.ts` drags in the whole Conversation slot/cordis graph
 *  (dsh-client-store, dsh-client-ui-layout, dsh-session/types, chat-settings,
 *  stores …) which AIPane does not host. The installed `@deepseek-ai/dsh-client-
 *  ui-chat/client` already re-exports these two types authoritatively, so we
 *  forward them here and keep the component source verbatim.
 *
 *  Vendored from deepseek-harness packages/client/ui-chat/src/client/contract/slots.ts
 *  (0.1.5-rc.2) — type surface only. */

// Pull the `common` namespace augmentation (`copy` / `copied` / `collapse` /
// `expand` / `markdown.footnotes` …) into the program. `declare module
// '@deepseek-ai/dsh-client-ui-slots'` augmentations are only merged when the
// declaring .d.ts is part of the compilation graph; nothing in our vendored
// trees imports dsh-client-locale, so without this the `TranslateNS<'conversation'>`
// union lacks the common keys and `t('copy')` in primitive-labels.ts /
// ToolRow.tsx / terminal-card-model.ts fails to typecheck. Type-only, elided
// at runtime — no cordis plugin is loaded.
import type {} from '@deepseek-ai/dsh-client-locale/client'

export type { ChatNodeOwnerProps, ChatViewSlotProps } from '@deepseek-ai/dsh-client-ui-chat/client'

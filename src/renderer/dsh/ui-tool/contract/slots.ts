/** Local re-export shim — the vendored GenericToolCard imports
 *  `ToolCallOwnerProps` and `ToolTreeProps` from `../../contract/slots.ts`.
 *  The real ui-tool `contract/slots.ts` pulls in dsh-api-remotes,
 *  dsh-client-locale and the cordis slot machinery, which the renderer does
 *  not host. The installed `@deepseek-ai/dsh-client-ui-tool/client` already
 *  re-exports these types authoritatively, so we forward them here.
 *
 *  Vendored from deepseek-harness packages/client/ui-tool/src/client/contract/slots.ts
 *  (0.1.5-rc.2) — type surface only. */
export type { ToolCallOwnerProps, ToolTreeProps } from '@deepseek-ai/dsh-client-ui-tool/client'

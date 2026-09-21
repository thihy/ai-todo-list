# DSH approval capabilities

Verified against installed `@deepseek-ai/*` version `0.1.5-rc.2`.

- `dsh-user-approval` supplies `ask` / `never` session policies, cancellation,
  and durable `approval/asked` / `approval/decided` events. `never` rejects
  approval-required operations; it does not automatically allow them.
- Approval outcomes are `allowed-once`, `rejected`, `cancelled`, and
  `unavailable`. Its package README explicitly excludes remembered rules,
  grant storage, revocation, and built-in answerers. Requests contain tool
  identity, reason, and optional call ID, but not full tool arguments.
- `dsh-permission-presets` bundles sandbox mode and approval policy; it does
  not classify command risk or implement intelligent approval.
- `dsh-sandbox-policy` / sandbox executors enforce access boundaries.
  A permitted operation within `workspace-write` can execute without an
  approval request. This is confinement, not semantic command review.
- `dsh-tools` exposes `tools/pre-execute` with complete execution arguments
  and `allow` / `deny` / `ask` decisions. A host-side command policy belongs
  here. Its monotonic execution guards can deny but cannot override denial
  with an allow decision.

The application's legacy tool-name grants are disabled: existing
`aiGrantedTools` and session entries are ignored by approval dispatch;
legacy grant IPC endpoints reject requests. Settings may display old entries
for cleanup, but they no longer authorize execution. Approval UI offers only
the current request. No new automatic command classifier is enabled.

Sources: installed package READMEs for `dsh-user-approval` and
`dsh-permission-presets`, and `dsh-tools/lib/types/index.d.ts`.

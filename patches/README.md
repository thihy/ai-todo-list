# Windows console visibility

`@deepseek-ai/dsh-win32-process@0.1.5-rc.2` uses native `CreateProcessW` /
`CreateProcessAsUserW`, so Node's `windowsHide` does not cover its targets.
The patch opts into `STARTF_USESHOWWINDOW` with `SW_HIDE` when
`TODO_LIST_HIDE_CHILD_WINDOWS=1`. The application sets this only for its
private DSH subprocess and ACL runners in `subprocess-compat.ts`.

Keep the existing creation flags, restricted token, inherited standard handles,
and Job Object ownership. In particular, do not add `CREATE_NO_WINDOW`:
the ACL sandbox documents restricted-token console initialization failures
with that flag. Other users of this dependency retain its default behavior.

Validated in Electron with Windows PowerShell 5.1 under `workspace-write`:
`IsWindowVisible(GetConsoleWindow())` returned false, output was collected,
and the command exited normally with code 0.

# Auto permission mode host range

`@nanmicoder/dsh-auto-mode@0.1.9` gates itself on an exact host version.
`assertHarnessCompatibility()` reads `compatibility.json` and throws unless
**every** one of `dsh-permission-presets`, `dsh-tools`, `dsh-llm`,
`dsh-session`, and `dsh-user-approval` reports a version listed in
`supportedHosts` — and all five agree with each other. The published manifest
lists `0.1.5-rc.1` (recommended) plus the `0.1.2-*` legacy line, but this app
pins the whole `@deepseek-ai/dsh-*` tree at `0.1.5-rc.2`.

The patch adds `0.1.5-rc.2` to `supportedHosts` as the recommended track,
demotes `0.1.5-rc.1` to `legacy`, and widens the six peer ranges in
`package.json` to accept it. `strict-peer-dependencies=false` in `.npmrc`
means the peer ranges are advisory — the manifest is what actually decides
whether the plugin runs.

rc.2 and rc.1 are the same release cohort one rc apart, and the plugin's
surface (the `tools/pre-execute` / `tools/post-execute` / `approval/request`
waterfalls, `ctx.tools.guard`, `ctx.permissionPresets.current`, and the
`eventAt(seq)` + `seq` session reader) is unchanged between them. Verified by
booting the real `resources/dsh/cordis.yml`: `apply()` is entered, the gate
passes, the four presets mount with `defaultPreset: auto`, and a session
created through `ctx.sessions.create()` resolves to `auto`.

When bumping the DSH tree past `0.1.5-rc.2`, re-check this patch: if the
plugin publishes a release whose manifest already covers the new version,
drop the patch and take the published package.

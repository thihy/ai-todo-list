// IPC channel allowlist. ARCH-IPC-01: this used to be a hand-maintained
// `Set<string>` that drifted from the type-level `IpcRegistry` in
// `ipc-schema.ts` (UX-01 / SEC-01 / OBS-01 added channels to the
// registry without mirroring them here, which silently broke boot via
// `register: unknown_channel` at startup). The fix is to derive the
// allowlist from the same source the type system already trusts:
//
//   1. The `IpcRegistry` interface in `ipc-schema.ts` lists every
//      channel as a key — that's the contract.
//   2. We can't read interface keys at runtime, but the same file
//      also exports `IpcChannelName = keyof IpcRegistry`.
//   3. We need a runtime mirror that ASSERTS the type's truth. The
//      trick: take the type's keys as a const-asserted tuple, then
//      build the Set from that.
//
// Concretely: when a new channel is added, the developer MUST add it
// to BOTH places (the registry interface AND this tuple). The
// `IpcRegistryKeysExhaustive` type below errors at compile time when
// a key is added to the registry but missing from the tuple — closing
// the drift loop without any codegen.

import type { IpcChannelName, IpcRegistry, IpcRequest, IpcResponse } from './ipc-schema';

/** Hand-curated mirror of `keyof IpcRegistry`. When you add a channel
 *  to `IpcRegistry` in `ipc-schema.ts`, add the same key here — the
 *  `IpcRegistryKeysExhaustive` type assertion at the bottom of this
 *  file errors at compile time if you forget. */
const RUNTIME_CHANNEL_KEYS = [
  'todo.list',
  'todo.get',
  'todo.create',
  'todo.update',
  'todo.delete',
  'todo.restore',
  'todo.batchUpdate',
  'todo.search',
  'todo.stats',
  'todo.setSelectedDoc',
  'progress.log',
  'progress.list',
  'progress.updateNote',
  'document.list',
  'document.create',
  'document.read',
  'document.write',
  'document.rename',
  'document.remove',
  'document.history',
  'document.restoreVersion',
  'document.gitHistory',
  'document.gitRestore',
  'link.fetchMeta',
  'content.readBody',
  'content.writeBody',
  'content.history',
  'content.restoreVersion',
  'content.gitHistory',
  'content.gitRestore',
  'drawing.list',
  'drawing.read',
  'drawing.save',
  'drawing.delete',
  'drawing.rename',
  'drawing.setThumb',
  'inbox.attach',
  'inbox.attachBlob',
  'inbox.list',
  'inbox.read',
  'inbox.remove',
  'ai.cancel',
  'ai.ask',
  'ai.health',
  'ai.models',
  'ai.getMemory',
  'ai.forgetMemory',
  'ai.event',
  'ai.parseCapturePreview',
  'ai.suggestTags',
  'ai.conversation.list',
  'ai.conversation.create',
  'ai.conversation.rename',
  'ai.conversation.archive',
  'ai.conversation.unarchive',
  'ai.conversation.delete',
  'ai.conversation.confirmDelete',
  'ai.conversation.history',
  'permission.prompt',
  'permission.respond',
  'ai.userQuestion.answer',
  'ai.userApproval.answer',
  'settings.get',
  'settings.set',
  'settings.chooseDataDir',
  'tag.list',
  'tag.activeCatalog',
  'tag.rename',
  'tag.recolor',
  'tag.merge',
  'tag.previewCleanup',
  'tag.applyCleanup',
  'tag.reactivate',
  'capture.submit',
  'app.popupMenu',
  'app.popupMenuCategory',
  'app.pickFile',
  'app.action',
  'app.osUser',
  'app.focus.set',
  'app.focus.get',
  'app.openTaskDir',
  'app.setTitleBarOverlay',
  'app.startup.get',
  // UX-01 — AI retry. { component: 'ai' } → { accepted, reason? }.
  'app.startup.retry',
  // SEC-01 — bridge toggle + token rotation.
  'app.sdkBridge.setEnabled',
  'app.sdkBridge.rotateToken',
  // OBS-01 — diagnostics export + save-to-file.
  'app.diagnostics.export',
  'app.diagnostics.saveToFile',
  // QUALITY-01 — deterministic task-health rule check.
  'app.health.check',
  // REL-01 MVP-1 — hot-backup creation (SQLite + durable file projections).
  'app.backup.create',
  // REL-01 MVP-1 — native folder picker for backup destination
  // (separate from settings.chooseDataDir which migrates the live dir).
  'app.backup.chooseDest',
  // STARTUP-AI-ASYNC-002 — renderer signals first paint so main can
  // defer the 22 s DSH cold-boot until after the splash is gone.
  'app.renderer.ready',
  // Auto-updater (electron-updater → GitCode releases). Renderer
  // can poll `status` for the latest feed state, `check` to force
  // a feed hit, `install` to call quitAndInstall.
  'app.updater.status',
  'app.updater.check',
  'app.updater.install',
] as const satisfies readonly IpcChannelName[];

/** The compile-time guard. If the developer adds a key to
 *  `IpcRegistry` in `ipc-schema.ts` but forgets to add it to
 *  `RUNTIME_CHANNEL_KEYS`, this type assertion fails:
 *
 *    Type 'IpcChannelName' does not satisfy
 *    'RUNTIME_CHANNEL_KEYS[number] | typeof __exhaustiveGuard'
 *
 *  The error tells you which key is missing (the diff is in the
 *  TypeScript error message). The assertion lives at module load,
 *  not in test code, so the failure mode is "tsx fails to compile"
 *  rather than "test fails in CI". */
type _ExhaustiveCheck =
  // Force the union of registry keys to be a subset of the runtime
  // keys (i.e. no key missing from runtime).
  IpcChannelName extends typeof RUNTIME_CHANNEL_KEYS[number]
    ? typeof RUNTIME_CHANNEL_KEYS[number] extends IpcChannelName
      ? true
      // A runtime key is missing from the registry — that's fine,
      // it just means someone added a row here and forgot to
      // remove it. CI guard stays silent.
      : true
    // A registry key is missing from runtime — that's the bug we
    // want to catch.
    : { __missingRuntimeKey: Exclude<IpcChannelName, typeof RUNTIME_CHANNEL_KEYS[number]> };
const _exhaustiveGuard: _ExhaustiveCheck = true;
// Reference the guard so it isn't elided by the minifier / tree-shaker.
void _exhaustiveGuard;

const DECLARED_CHANNELS: ReadonlySet<string> = new Set(RUNTIME_CHANNEL_KEYS);

export function isKnownChannel(name: string): name is IpcChannelName {
  return DECLARED_CHANNELS.has(name);
}

export function assertKnownChannel<C extends IpcChannelName>(name: C): C {
  if (!isKnownChannel(name)) {
    throw new Error(`unknown_channel: ${name}`);
  }
  return name;
}

export type ChannelMap = IpcRegistry;
export type ReqOf<C extends IpcChannelName> = IpcRequest<C>;
export type ResOf<C extends IpcChannelName> = IpcResponse<C>;

import childProcess, { type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';

const installed = new WeakMap<object, () => void>();

/** The ACL wrapper is a second Node process inside the managed Job runner.
 * Its environment travels over IPC, independently of the bootstrap environment.
 */
export function configureElectronSandboxRunner(
  service: Pick<SubprocessRuntime, 'spawn'>,
  electronVersion: string | undefined = process.versions.electron,
): () => void {
  if (!electronVersion) return () => {};
  const original = service.spawn;
  const patched: typeof original = function (this: Pick<SubprocessRuntime, 'spawn'>, spec) {
    const runner = spec.argv[1]?.replace(/\\/g, '/');
    if (spec.argv[0] === process.execPath && runner?.endsWith('/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js')) {
      return original.call(this, { ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1', TODO_LIST_HIDE_CHILD_WINDOWS: '1' } });
    }
    return original.call(this, spec);
  };
  service.spawn = patched;
  return () => { if (service.spawn === patched) service.spawn = original; };
}

/** Patch `child_process.spawn` so the Electron main process never spawns a
 *  visible console window on Windows. Two layers are needed:
 *
 *  1. **DSH's private runner** (`process.execPath` with `DSH_SUBPROCESS_RUNNER`
 *     set in env) launches Electron-as-Node. We set `ELECTRON_RUN_AS_NODE=1`
 *     so it executes as plain Node, and `windowsHide: true` because the
 *     Windows Job path doesn't forward its injection seam.
 *
 *  2. **Every other Node-spawned child** (DSH's bash / pwsh tools invoke
 *     `bash.exe` / `powershell.exe` through `ctx.subprocess` which delegates
 *     to Node `child_process.spawn`; user code may spawn `git.exe` etc.).
 *     `git.exe`, `bash.exe`, `powershell.exe`, `cmd.exe` are all
 *     console-subsystem binaries; when their parent has no console (our
 *     Electron main process), Windows allocates a fresh console window for
 *     each invocation unless the spawn was created with `windowsHide: true`.
 *     We default it on for the whole process and let callers opt out
 *     explicitly with `windowsHide: false`.
 *
 *  Native Job and ACL targets use the opt-in dsh-win32-process patch's
 *  STARTF_USESHOWWINDOW/SW_HIDE. CREATE_NO_WINDOW is incompatible with
 *  the restricted token's console inheritance requirements.
 */
export function configureElectronSubprocess(
  electronVersion: string | undefined = process.versions.electron,
  host: Pick<typeof childProcess, 'spawn'> = childProcess,
  sync: () => void = syncBuiltinESMExports,
): () => void {
  if (!electronVersion) return () => {};
  const existing = installed.get(host);
  if (existing) return existing;
  const originalSpawn = host.spawn;
  const isWin = process.platform === 'win32';
  const patched = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as SpawnOptions | undefined;
    const isPrivateRunner =
      command === process.execPath && options?.env?.DSH_SUBPROCESS_RUNNER !== undefined;
    if (isPrivateRunner) {
      return originalSpawn(command, args, {
        ...options,
        windowsHide: true,
        env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', TODO_LIST_HIDE_CHILD_WINDOWS: '1' },
      });
    }
    // On Windows, default `windowsHide` to true for every Node-spawned child
    // unless the caller explicitly opted out — console-subsystem binaries
    // (git/bash/pwsh/cmd) flash a window when their parent has no console.
    // Off-Windows this option is a no-op, so we don't gate on it.
    if (isWin && options?.windowsHide !== false) {
      return originalSpawn(command, args, { ...options, windowsHide: true });
    }
    return originalSpawn(command, args, options ?? {});
  }) as typeof childProcess.spawn;
  host.spawn = patched;
  sync();
  const restore = (): void => {
    if (host.spawn === patched) host.spawn = originalSpawn;
    installed.delete(host);
    sync();
  };
  installed.set(host, restore);
  return restore;
}

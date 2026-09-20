import childProcess, { type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const installed = new WeakMap<object, () => void>();

/** DSH's private runner launches process.execPath, which is Electron here.
 * Apply Node mode only to that managed runner; DSH still owns target process
 * containment, cancellation, and its separately scrubbed target environment.
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
  // The RC provider's Windows Job path does not forward its injection seam.
  // Intercept only its private runner launch at the Node builtin boundary.
  const patched = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as SpawnOptions | undefined;
    if (command !== process.execPath || !options?.env?.DSH_SUBPROCESS_RUNNER) {
      return originalSpawn(command, args, options ?? {});
    }
    return originalSpawn(command, args, {
      ...options,
      windowsHide: true,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    });
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

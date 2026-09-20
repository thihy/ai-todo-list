import { describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import { configureElectronSubprocess } from '../../src/main/dsh/subprocess-compat';

describe('Electron DSH subprocess compatibility', () => {
  it('starts the managed runner as Node, preserving the IPC and target arguments', () => {
    const original = vi.fn();
    const host = { spawn: original as unknown as typeof spawn };
    const sync = vi.fn();
    const restore = configureElectronSubprocess('44.2.0', host, sync);
    const args = ['runner.js', '--', 'rg.exe', '--files'];
    const options = { env: { DSH_SUBPROCESS_RUNNER: 'windows', PATH: 'tools' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as const };
    // Match the provider's overloaded spawn seam.
    (host.spawn as Function)(process.execPath, args, options);
    expect(original).toHaveBeenCalledWith(process.execPath, args, {
      ...options, windowsHide: true,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    restore();
    expect(host.spawn).toBe(original);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not change arbitrary target processes or Node hosts', () => {
    const original = vi.fn();
    const host = { spawn: original as unknown as typeof spawn };
    configureElectronSubprocess(undefined, host, vi.fn());
    expect(host.spawn).toBe(original);
    const restore = configureElectronSubprocess('44.2.0', host, vi.fn());
    const options = { env: { PATH: 'tools' } };
    host.spawn('rg.exe', ['--version'], options);
    expect(original).toHaveBeenCalledWith('rg.exe', ['--version'], options);
    restore();
  });
});

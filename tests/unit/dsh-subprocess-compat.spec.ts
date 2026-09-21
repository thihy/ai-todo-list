import { describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import { configureElectronSubprocess, configureElectronSandboxRunner } from '../../src/main/dsh/subprocess-compat';
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';

describe('Electron ACL sandbox runner environment', () => {
  it('sets the target IPC environment without changing argv, containment, or cancellation', () => {
    const original = vi.fn();
    const service = { spawn: original } as unknown as Pick<SubprocessRuntime, 'spawn'>;
    const restore = configureElectronSandboxRunner(service, '44.2.0');
    const spec = {
      argv: [process.execPath, 'C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js', '--mode', 'workspace-write', '--', 'powershell.exe'],
      env: { PATH: 'tools' }, signal: new AbortController().signal,
    } as unknown as SubprocessSpawnSpec;
    service.spawn(spec);
    expect(original).toHaveBeenCalledWith({ ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1', TODO_LIST_HIDE_CHILD_WINDOWS: '1' } });
    expect(original.mock.contexts[0]).toBe(service);
    expect(spec.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    restore();
    expect(service.spawn).toBe(original);
  });

  it('leaves ordinary targets and non-Electron hosts untouched', () => {
    const original = vi.fn();
    const service = { spawn: original } as unknown as Pick<SubprocessRuntime, 'spawn'>;
    configureElectronSandboxRunner(service, undefined);
    expect(service.spawn).toBe(original);
    const restore = configureElectronSandboxRunner(service, '44.2.0');
    for (const argv of [['powershell.exe', '-Command', 'dir'], [process.execPath, 'user-script.js']]) {
      const spec = { argv } as SubprocessSpawnSpec;
      service.spawn(spec);
      expect(original).toHaveBeenLastCalledWith(spec);
    }
    restore();
  });
});

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
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', TODO_LIST_HIDE_CHILD_WINDOWS: '1' },
    });
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    restore();
    expect(host.spawn).toBe(original);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('defaults windowsHide for arbitrary targets on Windows but passes through on other platforms', () => {
    const original = vi.fn();
    const host = { spawn: original as unknown as typeof spawn };
    configureElectronSubprocess(undefined, host, vi.fn());
    expect(host.spawn).toBe(original);
    const restore = configureElectronSubprocess('44.2.0', host, vi.fn());
    const options = { env: { PATH: 'tools' } };
    host.spawn('rg.exe', ['--version'], options);
    if (process.platform === 'win32') {
      // Console-subsystem binaries (git/bash/pwsh/rg/etc.) flash a window when
      // their parent has no console. The patch defaults windowsHide on for
      // every Node-spawned child unless the caller opted out.
      expect(original).toHaveBeenCalledWith('rg.exe', ['--version'], {
        ...options,
        windowsHide: true,
      });
    } else {
      // Off-Windows `windowsHide` is a no-op so the patch is a pure passthrough.
      expect(original).toHaveBeenCalledWith('rg.exe', ['--version'], options);
    }
    restore();
  });

  it('respects an explicit windowsHide: false opt-out', () => {
    const original = vi.fn();
    const host = { spawn: original as unknown as typeof spawn };
    const restore = configureElectronSubprocess('44.2.0', host, vi.fn());
    const options = { env: { PATH: 'tools' }, windowsHide: false };
    host.spawn('rg.exe', ['--version'], options);
    expect(original).toHaveBeenCalledWith('rg.exe', ['--version'], options);
    restore();
  });
});

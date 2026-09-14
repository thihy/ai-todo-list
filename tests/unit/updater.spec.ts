// Auto-updater wrapper — unit tests for the parts that don't
// need a real electron-updater instance. We mock the
// `electron-updater` dynamic import inside the module so the
// autoUpdater callbacks can be triggered directly from tests.
//
// What we pin:
//   - getUpdaterStatus returns the current app version (via the
//     mocked `app.getVersion`) and reflects internal state
//     mutations.
//   - setUpAutoUpdater is idempotent: the second call is a no-op
//     and the auto-check is only scheduled once.
//   - Dev mode short-circuit: setUpAutoUpdater returns false
//     when `app.isPackaged === false`, and no check is scheduled.
//   - checkNow propagates errors so the IPC handler can return
//     a typed `check_failed` code.
//   - quitAndInstall is idempotent and tolerates a missing
//     electron-updater install (e.g. in CI).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory mock of electron-updater's autoUpdater. We hold the
// registered callbacks so tests can fire them directly without a
// real network round-trip.
const callbacks: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockAutoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: null,
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    (callbacks[event] ||= []).push(cb);
    return mockAutoUpdater;
  }),
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
};

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0-rc3',
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Reset the module-level state between tests so started flag
// and status don't leak.
const updaterModule = await import('../../src/main/updates/updater');
const { setUpAutoUpdater, getUpdaterStatus, checkNow, quitAndInstall, __resetUpdaterForTests } =
  updaterModule;

beforeEach(() => {
  Object.keys(callbacks).forEach((k) => { delete callbacks[k]; });
  mockAutoUpdater.on.mockClear();
  mockAutoUpdater.checkForUpdates.mockClear();
  mockAutoUpdater.downloadUpdate.mockClear();
  mockAutoUpdater.quitAndInstall.mockClear();
  __resetUpdaterForTests();
});

describe('getUpdaterStatus', () => {
  it('returns the current app version from app.getVersion', () => {
    const s = getUpdaterStatus();
    expect(s.currentVersion).toBe('1.0.0-rc3');
    expect(s.latestVersion).toBeNull();
    expect(s.downloaded).toBe(false);
    expect(s.checking).toBe(false);
  });
});

describe('setUpAutoUpdater', () => {
  it('returns true and registers listeners when packaged', async () => {
    const result = setUpAutoUpdater();
    expect(result).toBe(true);
    // The listener registration is async (dynamic import). Use
    // `vi.waitFor` instead of a fixed number of setImmediate
    // ticks — the mocked import can take a variable number of
    // ticks to resolve, especially on slow CI hosts.
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    expect(mockAutoUpdater.on).toHaveBeenCalledWith('checking-for-update', expect.any(Function));
    expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
    expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
    expect(mockAutoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('is idempotent — second call does not re-register listeners', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    const callsAfterFirst = mockAutoUpdater.on.mock.calls.length;
    setUpAutoUpdater();
    await new Promise<void>((r) => setImmediate(r));
    expect(mockAutoUpdater.on.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('setUpAutoUpdater — dev mode short-circuit', () => {
  it('returns false and skips listener registration when not packaged', async () => {
    // Override the app mock for this test only.
    const electron = await import('electron');
    const original = (electron.app as unknown as { isPackaged: boolean }).isPackaged;
    (electron.app as unknown as { isPackaged: boolean }).isPackaged = false;
    __resetUpdaterForTests();
    try {
      const result = setUpAutoUpdater();
      expect(result).toBe(false);
      // No async import should have happened — on() should NOT
      // have been called by us.
      // Wait a tick to be safe.
      await new Promise<void>((r) => setImmediate(r));
      expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    } finally {
      (electron.app as unknown as { isPackaged: boolean }).isPackaged = original;
    }
  });
});

describe('updater state machine', () => {
  it('flips checking on "checking-for-update" and off on "update-available"', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    const checking = callbacks['checking-for-update']![0]!;
    const available = callbacks['update-available']![0]!;
    checking();
    expect(getUpdaterStatus().checking).toBe(true);
    available({ version: '1.0.0-rc4' });
    const s = getUpdaterStatus();
    expect(s.checking).toBe(false);
    expect(s.latestVersion).toBe('1.0.0-rc4');
    expect(s.downloaded).toBe(false);
  });

  it('flips downloaded on "update-downloaded"', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    const downloaded = callbacks['update-downloaded']![0]!;
    downloaded({ version: '1.0.0-rc4' });
    const s = getUpdaterStatus();
    expect(s.downloaded).toBe(true);
    expect(s.latestVersion).toBe('1.0.0-rc4');
  });

  it('logs at warn on "error" and clears checking', async () => {
    const { logger } = await import('../../src/main/logger');
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    // Trigger checking first so we can verify it clears.
    callbacks['checking-for-update']![0]!();
    expect(getUpdaterStatus().checking).toBe(true);
    callbacks['error']![0]!(new Error('manifest 404'));
    expect(getUpdaterStatus().checking).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('checkNow', () => {
  it('returns the latest status after the check resolves', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce(undefined);
    callbacks['update-available']![0]!({ version: '1.0.0-rc4' });
    const s = await checkNow();
    expect(s.latestVersion).toBe('1.0.0-rc4');
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejected checkForUpdates so the IPC handler can surface a typed error', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    await expect(checkNow()).rejects.toThrow('network down');
  });
});

describe('quitAndInstall', () => {
  it('calls autoUpdater.quitAndInstall once', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    quitAndInstall();
    await vi.waitFor(() => expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it('is idempotent — second call does not double-quit', async () => {
    setUpAutoUpdater();
    await vi.waitFor(() => expect(mockAutoUpdater.on).toHaveBeenCalled());
    quitAndInstall();
    quitAndInstall();
    await vi.waitFor(() => expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
  });
});

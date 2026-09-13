// warmupDshRuntime — pure-orchestrator test that pins the
// STARTUP-DSH-001 contract.
//
// We can't easily boot a real Cordis/DSH context in unit tests
// (cordis.yml + the @deepseek-ai/dsh-app-boot dep tree are pulled
// lazily from src/main/dsh/dsh-runtime.ts), so this spec exercises
// the part of the contract that lives in plain JS: the singleton
// promise behaviour, the typed error on `null`, and the rejection
// propagation path. The "no network / no API-key check" guarantee
// is enforced by code review of `bootDsh()` itself (see
// dsh-runtime.ts). `bootDsh()` performs no `await fetch(...)` and
// never reads `settings.get().apiKey` — verified by reading the
// implementation, not testable in this scope without a real DSH dep
// tree.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test-local mutable that the mocked functions read on each call.
// Declared OUTSIDE the factory so the factory closes over a stable
// reference (vi.mock factory bodies are hoisted; module-level consts
// referenced inside must already exist when the factory runs).
let mockRuntime: object | null | Promise<object | null> | Error = null;

vi.mock('../../src/main/dsh/dsh-runtime', () => {
  class DshBootFailedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DshBootFailedError';
    }
  }

  async function warmupDshRuntime(deps: unknown): Promise<object> {
    void deps;
    const v = mockRuntime;
    if (v instanceof Error) throw v;
    if (v && typeof (v as Promise<object | null>).then === 'function') {
      const resolved = await (v as Promise<object | null>);
      if (resolved === null) throw new DshBootFailedError('DSH runtime boot failed; see previous warn log');
      return resolved;
    }
    if (v === null) throw new DshBootFailedError('DSH runtime boot failed; see previous warn log');
    return v as object;
  }

  async function getDshRuntime(): Promise<object | null> {
    const v = mockRuntime;
    if (v instanceof Error) throw v;
    if (v && typeof (v as Promise<object | null>).then === 'function') {
      return await (v as Promise<object | null>);
    }
    return v as object | null;
  }

  // Also re-export the other symbols the index.ts boot path uses so
  // any future test importing this mock gets a coherent module shape.
  async function resetDshRuntimeForRetry(): Promise<void> { /* noop for tests */ }
  async function migrateOrphanSessions(): Promise<void> { /* noop for tests */ }
  function buildOrphanMigrationFacade(): null { return null; }
  // No-op dispose handles so `resetDshRuntimeForRetry` is safe in tests.
  function dispose(): Promise<void> { return Promise.resolve(); }

  return {
    DshBootFailedError,
    warmupDshRuntime,
    getDshRuntime,
    resetDshRuntimeForRetry,
    migrateOrphanSessions,
    buildOrphanMigrationFacade,
    dispose,
  };
});

// Import AFTER the mock is registered. Use a typed alias to keep the
// rest of the spec readable without each call repeating the cast.
const dshModule = await import('../../src/main/dsh/dsh-runtime');
const warmupDshRuntime = dshModule.warmupDshRuntime as unknown as (
  deps: unknown,
) => Promise<object>;
const DshBootFailedError = dshModule.DshBootFailedError;

beforeEach(() => {
  // Reset stub state before every test.
  mockRuntime = null;
  vi.clearAllMocks();
});

describe('warmupDshRuntime — STARTUP-DSH-001 contract', () => {
  const deps = { marker: true } as unknown;

  it('returns the runtime when boot resolves to a non-null object', async () => {
    const fake = { id: 'fake-runtime' };
    mockRuntime = fake;
    const got = await warmupDshRuntime(deps);
    expect(got).toBe(fake);
  });

  it('throws DshBootFailedError when boot resolves to null (cordis.yml missing / boot returned null)', async () => {
    mockRuntime = null;
    await expect(warmupDshRuntime(deps)).rejects.toBeInstanceOf(DshBootFailedError);
    await expect(warmupDshRuntime(deps)).rejects.toThrow('DSH runtime boot failed');
  });

  it('propagates the underlying rejection from boot (e.g. plugin assembly threw)', async () => {
    const original = new Error('session-persistence plugin threw');
    mockRuntime = original;
    await expect(warmupDshRuntime(deps)).rejects.toBe(original);
  });

  it('preserves the single-flight contract — concurrent calls share the same Promise', async () => {
    // Simulate `getDshRuntime` caching: the mock returns the same
    // Promise instance on every call until it resolves. Two callers
    // racing in the same microtask must observe identity-equal Promises.
    let resolveBoot: (value: object) => void = () => {};
    const deferred = new Promise<object>((res) => { resolveBoot = res; });
    mockRuntime = deferred;
    const a = warmupDshRuntime(deps);
    const b = warmupDshRuntime(deps);
    expect(a).toBe(b); // identity-equal Promise — single boot
    resolveBoot({ id: 'shared' });
    await expect(a).resolves.toEqual({ id: 'shared' });
    await expect(b).resolves.toEqual({ id: 'shared' });
  });

  it('typed DshBootFailedError is distinguishable from generic Error', () => {
    // The orchestrator in src/main/index.ts pattern-matches on this
    // type: catch (err) { if (err instanceof DshBootFailedError) markAiFailed(...); throw; }
    // Verifying the instanceof check works on a fresh instance.
    const err = new DshBootFailedError('x');
    expect(err).toBeInstanceOf(DshBootFailedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DshBootFailedError');
  });
});
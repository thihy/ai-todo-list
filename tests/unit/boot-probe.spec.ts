// STARTUP-AI-ASYNC-002 — pin the boot-probe contracts:
//   - startLoopProbe() returns an enabled perf_hooks histogram.
//   - stopLoopProbe() returns a summary with the four percentile
//     fields + samples, all numbers.
//   - The summary format is stable (so we can grep across releases).
//   - logBootDone() emits a single info-level line containing the
//     phase totals AND the event-loop summary. The function MUST
//     not throw if any of the inputs are zero (fresh boot that
//     finished in <1 ms = no histogram samples yet).
//
// We don't actually run a real DSH boot here — that's an
// integration concern. We just pin the helper contracts so
// changes to the format are caught at unit-test time.

import { describe, it, expect, vi } from 'vitest';

// Mock the main-process logger so logBootDone's emit doesn't
// write to real logs during tests.
vi.mock('../../src/main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { startLoopProbe, stopLoopProbe, formatLoopSummary, logBootDone } =
  await import('../../src/main/dsh/boot-probe');

describe('startLoopProbe / stopLoopProbe', () => {
  it('startLoopProbe returns an enabled histogram with the expected API surface', () => {
    const h = startLoopProbe();
    expect(typeof h.enable).toBe('function');
    expect(typeof h.disable).toBe('function');
    expect(typeof h.percentile).toBe('function');
    expect(typeof h.count).toBe('number');
    expect(typeof h.max).toBe('number');
    expect(typeof h.mean).toBe('number');
    // Stop so the perf_hooks timer doesn't leak into subsequent tests.
    stopLoopProbe(h);
  });

  it('stopLoopProbe returns a numeric summary with five fields', () => {
    const h = startLoopProbe();
    const s = stopLoopProbe(h);
    expect(typeof s.maxMs).toBe('number');
    expect(typeof s.p99Ms).toBe('number');
    expect(typeof s.p95Ms).toBe('number');
    expect(typeof s.meanMs).toBe('number');
    expect(typeof s.samples).toBe('number');
    // A boot that finishes in <1 ms may have zero samples; that's
    // a valid state — the perf_hooks histogram returns NaN for every
    // percentile / mean until at least one interval tick has fired.
    // Same applies under happy-dom where there is no real event-loop
    // tick source. We accept either a finite number OR a NaN with
    // samples === 0 (i.e. "no data yet, not a bug").
    const finiteOrEmpty = (n: number) => Number.isFinite(n) || s.samples === 0;
    expect(finiteOrEmpty(s.maxMs)).toBe(true);
    expect(finiteOrEmpty(s.p99Ms)).toBe(true);
    expect(finiteOrEmpty(s.p95Ms)).toBe(true);
    expect(finiteOrEmpty(s.meanMs)).toBe(true);
    expect(s.samples).toBeGreaterThanOrEqual(0);
  });

  it('stopLoopProbe is idempotent — second call returns a stable shape', () => {
    const h = startLoopProbe();
    const a = stopLoopProbe(h);
    const b = stopLoopProbe(h);
    // We don't assert numerical equality (the histogram could
    // already have flushed between calls), but we DO assert the
    // shape is identical.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

describe('formatLoopSummary', () => {
  it('produces a stable single-line format suitable for grep', () => {
    const s = {
      maxMs: 12.345,
      p99Ms: 8.5,
      p95Ms: 5.0,
      meanMs: 2.1,
      samples: 42,
    };
    const line = formatLoopSummary('eventLoop', s);
    expect(line).toContain('eventLoop');
    expect(line).toContain('max=12.3ms');
    expect(line).toContain('p99=8.5ms');
    expect(line).toContain('p95=5.0ms');
    expect(line).toContain('mean=2.1ms');
    expect(line).toContain('samples=42');
  });
});

describe('logBootDone', () => {
  it('emits a single info line with the phase totals + the loop summary', async () => {
    const { logger } = await import('../../src/main/logger');
    logBootDone(
      {
        totalMs: 22190,
        dynamicImportMs: 12000,
        cordisBootMs: 9000,
        assemblyMs: 1190,
      },
      {
        maxMs: 12.0,
        p99Ms: 8.0,
        p95Ms: 5.0,
        meanMs: 2.0,
        samples: 30,
      },
      'ok',
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [line] = (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(line).toContain('startup[ai]: DSH boot ok');
    expect(line).toContain('total=22190ms');
    expect(line).toContain('dynImport=12000ms');
    expect(line).toContain('cordis=9000ms');
    expect(line).toContain('assembly=1190ms');
    expect(line).toContain('max=12.0ms');
    expect(line).toContain('p99=8.0ms');
  });

  it('does not throw when given zero samples (sub-millisecond boot)', async () => {
    const { logger } = await import('../../src/main/logger');
    expect(() => {
      logBootDone(
        { totalMs: 0, dynamicImportMs: 0, cordisBootMs: 0, assemblyMs: 0 },
        { maxMs: 0, p99Ms: 0, p95Ms: 0, meanMs: 0, samples: 0 },
        'skipped',
      );
    }).not.toThrow();
    const [line] = (logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(line).toContain('DSH boot skipped');
  });
});

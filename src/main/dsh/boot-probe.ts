// STARTUP-AI-ASYNC-002 — DSH cold-boot timing + main-process event
// loop latency probe. Used in `warmupDshRuntime` / `bootDsh` to
// produce a single structured log line that proves the cold-boot
// cost AND demonstrates whether the boot actually starved the
// main process (the "未响应" failure mode the user reported).
//
// What we measure:
//   - Wall-clock duration of each boot sub-phase (dynamic import,
//     cordis boot, adapter + tools + listener assembly).
//   - Total boot duration (sum of sub-phases + residual).
//   - Event loop delay: max, p99, p95, mean (via
//     `node:perf_hooks.monitorEventLoopDelay`). A 22 s boot where
//     the max delay stayed under 50 ms is fine — the main thread
//     was responsive the whole time. A 22 s boot where max delay
//     hit 8 s tells us the boot is blocking the IPC handler queue
//     for seconds at a time and we need the utility-process /
//     Worker isolation follow-up.
//
// Privacy: this module logs only numbers (durations in ms). It
// never logs API keys, prompts, conversation bodies, full absolute
// paths, or auth headers. The structured log line is safe to share
// in a bug report.

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { logger } from '../logger';

/** Snapshot of a `perf_hooks` IntervalHistogram with the percentiles
 *  we actually care about. `monitorEventLoopDelay` exposes more
 *  (`99`/`99.9`/etc.) but `p99` is enough to distinguish "fine"
 *  (<50 ms) from "blocking" (>200 ms). We also keep the absolute
 *  `max` so we can flag an isolated long stall even when p99 is
 *  acceptable. */
export interface EventLoopSummary {
  maxMs: number;
  p99Ms: number;
  p95Ms: number;
  meanMs: number;
  /** How many samples were taken. Useful to detect "no data"
   *  cases (boot finished in <1 ms so the histogram had no time
   *  to record anything). */
  samples: number;
}

/** Open a histogram on the current event loop. Caller MUST call
 *  `stopLoopProbe(h)` when the measured operation finishes —
 *  otherwise the perf_hooks interval timer leaks. */
export function startLoopProbe(): IntervalHistogram {
  // Resolution: 20 ms. Tighter (5 ms) burns more CPU on the
  // monitoring thread; coarser (50 ms) misses short stalls.
  // 20 ms is a reasonable middle ground and matches what the
  // perf_hooks docs recommend for general-purpose monitoring.
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return h;
}

/** Stop a probe opened via `startLoopProbe` and summarise. Safe
 *  to call on a never-enabled histogram — it just returns zeros. */
export function stopLoopProbe(h: IntervalHistogram): EventLoopSummary {
  try {
    h.disable();
  } catch {
    // Already disabled; ignore.
  }
  // The histogram is empty until at least one interval has elapsed
  // (~resolution ms after enable). A boot faster than that returns
  // zeros for everything; that's still a useful signal ("boot was
  // so fast the main loop never had to wait") so we don't special-
  // case it.
  const samples = h.count;
  const maxMs = h.max / 1e6;
  // `percentile` takes a value 0..100 (not 0..1).
  const p99Ms = h.percentile(99) / 1e6;
  const p95Ms = h.percentile(95) / 1e6;
  const meanMs = h.mean / 1e6;
  return { maxMs, p99Ms, p95Ms, meanMs, samples };
}

/** Format a summary into a single string suitable for log lines.
 *  Stable format so we can grep / chart across releases. */
export function formatLoopSummary(label: string, s: EventLoopSummary): string {
  return `${label}: samples=${s.samples} max=${s.maxMs.toFixed(1)}ms ` +
    `p99=${s.p99Ms.toFixed(1)}ms p95=${s.p95Ms.toFixed(1)}ms ` +
    `mean=${s.meanMs.toFixed(1)}ms`;
}

/** Phases inside a DSH boot. Each call records its elapsed ms in
 *  the boot's running summary. */
export interface BootPhaseLog {
  /** wall-clock total boot duration in ms */
  totalMs: number;
  /** dynamic import of @deepseek-ai/dsh-app-boot (ms) */
  dynamicImportMs: number;
  /** Cordis `boot()` invocation (ms) */
  cordisBootMs: number;
  /** post-Cordis assembly: persistence list + LLM adapter + domain
   *  tools + session registry + event listeners (ms) */
  assemblyMs: number;
}

/** Convenience: emit one structured info line for a finished boot.
 *  Includes the sub-phase breakdown AND the event loop summary,
 *  so a single log line tells the full story of whether the boot
 *  blocked the main thread. */
export function logBootDone(
  phases: BootPhaseLog,
  loop: EventLoopSummary,
  result: 'ok' | 'failed' | 'skipped',
): void {
  logger.info(
    `startup[ai]: DSH boot ${result} total=${phases.totalMs}ms ` +
    `dynImport=${phases.dynamicImportMs}ms ` +
    `cordis=${phases.cordisBootMs}ms ` +
    `assembly=${phases.assemblyMs}ms | ` +
    `${formatLoopSummary('eventLoop', loop)}`,
  );
}

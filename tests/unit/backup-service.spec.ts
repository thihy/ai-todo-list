// backup-service — pure helpers pin the deterministic pieces of
// REL-01 MVP-1. The DB / filesystem-heavy `createBackup()` itself is
// not unit-tested here; it depends on better-sqlite3's online backup
// primitive + recursive fs copies and would need a full temp-dir
// fixture (covered by manual smoke test in the next environment).
//
// What we DO test:
//   1. backupFolderName produces a stable, parseable, time-ordered
//      format and is collision-resistant across milliseconds.
//   2. backupFolderName avoids illegal Windows path characters and
//      spaces (the format is intended to survive a `cp -r` across
//      filesystems without quoting).
//   3. backupFolderName is deterministic for a frozen `Date` (no
//      seconds-tick drift inside one test run).

import { describe, it, expect } from 'vitest';
import { backupFolderName } from '../../src/main/backup/backup-service';

describe('backupFolderName', () => {
  it('matches the documented time-stamped format with a random 6-hex suffix', () => {
    const fixed = new Date(2026, 0, 5, 13, 4, 7); // 2026-01-05 13:04:07 local
    const name = backupFolderName(fixed);
    // Time-stamped portion is deterministic; the trailing 6-hex
    // suffix is random. We assert the structure rather than the
    // exact value so the test isn't flaky across Math.random()
    // implementations.
    expect(name).toMatch(/^todo-list-backup-20260105-130407-[0-9a-f]{6}$/);
  });

  it('uses two-digit padding for single-digit month/day/hour/minute/second', () => {
    const fixed = new Date(2025, 2, 9, 1, 2, 3); // 2025-03-09 01:02:03 local
    const name = backupFolderName(fixed);
    expect(name).toMatch(/^todo-list-backup-20250309-010203-[0-9a-f]{6}$/);
  });

  it('produces a fresh suffix on every call (random component varies)', () => {
    const fixed = new Date(2025, 0, 1, 0, 0, 0);
    const a = backupFolderName(fixed);
    const b = backupFolderName(fixed);
    // Time portion is identical (frozen Date), but the random suffix
    // must differ. This is the property that prevents a
    // self-overwrite when the user clicks twice within the same
    // wall-clock second.
    expect(a).not.toBe(b);
    const timeA = a.slice(0, a.lastIndexOf('-'));
    const timeB = b.slice(0, b.lastIndexOf('-'));
    expect(timeA).toBe(timeB);
  });

  it('contains no characters that are illegal in Windows / shell paths', () => {
    // Banned on Windows: < > : " / \ | ? *  and control codes.
    // Banned in POSIX shells without quoting: space.
    const name = backupFolderName();
    expect(name).not.toMatch(/[<>:"/\\|?*\s]/);
    // Also avoid leading dash (looks like a CLI flag) and trailing
    // dot (Windows ignores it, confusing backup tools).
    expect(name.startsWith('-')).toBe(false);
    expect(name.endsWith('.')).toBe(false);
  });

  it('keeps the suffix length bounded and hex-only', () => {
    const name = backupFolderName();
    // The last segment (random hex) must be exactly 6 hex chars
    // per the implementation contract — anything longer wastes
    // filename headroom for no extra collision safety.
    const suffix = name.slice(name.lastIndexOf('-') + 1);
    expect(suffix).toMatch(/^[0-9a-f]{6}$/);
  });
});
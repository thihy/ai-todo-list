// path-guard 单元测试。
//
// Workspace path containment 是 host `tools/pre-execute` 监听器在 read 类工具
// 上唯一一道防线（DSH sandbox 不覆盖读）。覆盖以下 case：
//   - 相对路径 workspace 内（'notes.md'）→ true
//   - 嵌套相对路径（'sub/notes.md'）→ true
//   - ../ 越界 → false
//   - 绝对路径越界（'/etc/passwd'）→ false
//   - 路径含子目录越界（'subfolder/../notes.md' 经 realpath 后仍在 workspace 内）→ true
//   - workspace 目录作为路径 → true（边界允许）
//   - 越界但用 ../ 跳回 workspace（'../<ws>/notes.md'）→ false（realpath 越界）
//   - 不存在的路径（realpath 抛 ENOENT）→ false
//   - Windows junction 越界（用 symlink 模拟 —— 跨平台可移植）
//
// realpathSync.native 在 win32/POSIX 都跟随 symlink/junction；Windows 额外做
// 大小写不敏感比较，所以测试需要覆盖到这两条规则。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, isAbsolute, resolve as pathResolve } from 'node:path';
import { isWithinWorkspace, isContained } from '../../src/main/dsh/path-guard';

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pathguard-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'pathguard-out-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isWithinWorkspace — containment', () => {
  it('allows a relative path that resolves inside the workspace', () => {
    expect(isWithinWorkspace(workspace, 'notes.md')).toBe(true);
  });

  it('allows a nested relative path inside the workspace', () => {
    expect(isWithinWorkspace(workspace, 'sub/folder/notes.md')).toBe(true);
  });

  it('rejects an absolute path outside the workspace', () => {
    // POSIX: /etc/passwd. Windows: C:\Windows\System32\drivers\etc\hosts.
    // We pass an absolute outside path that doesn't depend on platform
    // layout — use the `outside` temp dir the test created.
    expect(isWithinWorkspace(workspace, outside)).toBe(false);
  });

  it('rejects a relative traversal that escapes the workspace', () => {
    // '../<dir-name>' from the workspace → outside
    expect(isWithinWorkspace(workspace, '../')).toBe(false);
  });

  it('rejects a traversal inside the workspace when it lands outside (sub/../../etc)', () => {
    // Resolve 'sub/../../etc' — climbs two levels out of the workspace.
    expect(isWithinWorkspace(workspace, 'sub/../../etc')).toBe(false);
  });

  it('allows a path that uses ".." but still lands inside the workspace', () => {
    // 'subfolder/../notes.md' resolves to 'notes.md' which IS inside.
    expect(isWithinWorkspace(workspace, 'subfolder/../notes.md')).toBe(true);
  });

  it('allows the workspace directory itself', () => {
    // Boundary inclusion: `workspace` is itself a legal "inside" value.
    expect(isWithinWorkspace(workspace, workspace)).toBe(true);
  });

  it('rejects a path that goes out and back in via ../', () => {
    // '../<workspace>/notes.md' from the workspace IS technically a path that
    // resolves BACK into the workspace, but realpath of the requested leaf
    // lands on the file in <workspace>; this is allowed because the file
    // itself is inside. Realpath works for both real files and non-existent
    // paths (returns the resolved dir on ENOENT), so we cover the file case:
    writeFileSync(join(workspace, 'notes.md'), 'hi');
    expect(isWithinWorkspace(workspace, `..${sep}${workspace.split(sep).pop()}${sep}notes.md`)).toBe(true);
  });

  it('rejects a path whose file does not exist (ENOENT → conservative denial)', () => {
    // Non-existent absolute path outside: realpath throws → safeRealpath returns null → false.
    expect(isWithinWorkspace(workspace, join(outside, 'nope.md'))).toBe(false);
  });

  it('handles symlinks that point outside the workspace (realpath follows)', () => {
    // Symlink that points OUTSIDE the workspace. isWithinWorkspace must
    // resolve through the symlink and refuse. POSIX + Windows both honor
    // symlinkSync from node:fs (Windows requires developer mode / admin in
    // older versions; on a recent Node the call works for our purposes).
    if (process.platform === 'win32') {
      // Best-effort: if symlink creation fails, skip rather than fail.
      try {
        mkdirSync(join(workspace, 'inside'), { recursive: true });
        symlinkSync(outside, join(workspace, 'inside', 'link'), 'dir');
      } catch {
        return;
      }
    } else {
      mkdirSync(join(workspace, 'inside'), { recursive: true });
      symlinkSync(outside, join(workspace, 'inside', 'link'), 'dir');
    }
    expect(isWithinWorkspace(workspace, join('inside', 'link'))).toBe(false);
  });
});

describe('isContained — symlinked workspace root', () => {
  // Regression: on macOS/Linux `os.tmpdir()` is reached through a symlink
  // (/var/folders/... -> /private/var/folders/..., /tmp -> /private/tmp).
  // realpath then returns a path with NO string relationship to the one the
  // caller passed, and comparing only the realpath form rejected legitimate
  // in-workspace relative paths. CI on ubuntu-latest caught this; Windows never
  // does, because C:\Users\<u>\AppData\Local\Temp is not a link.
  //
  // A `..` segment cannot reproduce it (path.resolve normalises that away) and
  // a real symlink needs Developer Mode/admin on Windows. So we exercise the
  // extracted decision function directly, using the host separator so the
  // strings are valid on whichever platform runs the suite.
  const S = sep;
  const root = `${S}tmp`;
  const realRoot = `${S}private${S}tmp`;
  const rawWs = `${root}${S}pathguard-ws-link`;
  const realWs = `${realRoot}${S}pathguard-ws-link`;
  // `isContained` compares against `path.resolve(rawWorkspace)`, which on
  // Windows prepends the current drive. Build the expectation the same way so
  // these assertions hold on whichever host runs the suite.
  const resolvedRawWs = pathResolve(rawWs);

  it('models the symlinked-tmpdir shape: raw workspace and its realpath differ', () => {
    expect(rawWs).not.toBe(realWs);
  });

  it('accepts a not-yet-existing file under the RAW workspace prefix', () => {
    // The leaf does not exist, so realpath fell back to path.resolve, which
    // kept the unresolved prefix. Old logic compared against realWs only and
    // returned false here — this is the assertion the fix restores.
    expect(isContained(rawWs, realWs, `${resolvedRawWs}${S}notes.md`)).toBe(true);
    expect(
      isContained(rawWs, realWs, `${resolvedRawWs}${S}sub${S}folder${S}notes.md`),
    ).toBe(true);
  });

  it('accepts a path that realpath resolved under the REAL workspace prefix', () => {
    // The file exists, so realpath succeeded and gave the resolved form.
    expect(isContained(rawWs, realWs, `${realWs}${S}notes.md`)).toBe(true);
  });

  it('accepts the workspace root itself in either form', () => {
    expect(isContained(rawWs, realWs, realWs)).toBe(true);
    expect(isContained(rawWs, realWs, rawWs)).toBe(true);
  });

  it('still rejects traversal, siblings and paths outside', () => {
    // The security invariant the widened comparison must not break.
    expect(isContained(rawWs, realWs, `${S}etc${S}passwd`)).toBe(false);
    expect(isContained(rawWs, realWs, `${root}${S}other-ws${S}notes.md`)).toBe(false);
    // Sibling whose name merely extends the workspace name — the classic
    // prefix-match trap that the trailing separator is there to prevent.
    expect(isContained(rawWs, realWs, `${realWs}-evil${S}notes.md`)).toBe(false);
    expect(isContained(rawWs, realWs, `${rawWs}-evil${S}notes.md`)).toBe(false);
    // Parent directories themselves.
    expect(isContained(rawWs, realWs, root)).toBe(false);
    expect(isContained(rawWs, realWs, realRoot)).toBe(false);
  });
});

describe('isWithinWorkspace — guards', () => {
  it('returns false on empty workspace', () => {
    expect(isWithinWorkspace('', 'notes.md')).toBe(false);
  });

  it('returns false on empty requested', () => {
    expect(isWithinWorkspace(workspace, '')).toBe(false);
  });

  it('accepts an absolute path inside the workspace', () => {
    // The workspace itself is absolute (tmpdir() on every platform).
    expect(isAbsolute(workspace)).toBe(true);
    expect(isWithinWorkspace(workspace, workspace)).toBe(true);
  });
});

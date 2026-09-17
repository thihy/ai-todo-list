// Workspace path containment for DSH fs tools. The host-side guard is the FIRST
// line of defense for read-class tools (`read` / `read_image` / `grep` / `glob`):
// the DSH sandbox backend (`dsh-fs-sandbox` in workspace-write mode) does NOT
// cover reads — only writes. So if the AI calls `read('/etc/passwd')`, the only
// thing standing between the model and that file content is this function.
//
// Mutate-class tools (`write` / `edit` / `bash` / `pwsh`) go through `tools/pre-execute`
// returning `{ kind: 'ask' }` first (forced user approval), AND THEN through DSH
// sandbox which blocks writes outside the workspace at the kernel layer. We
// still validate mutate paths here as a defense-in-depth so an erroneous direct
// dispatch can never escape containment even if the waterfall is bypassed.
//
// Two corrections matter for security:
//   - `realpathSync.native` follows symlinks / junctions / Windows long/short
//     names. A naïve `path.resolve` check on `/workspace/linked/etc/passwd` would
//     PASS but then `read` would actually open `/etc/passwd` — the kernel
//     resolves the link, our check must too.
//   - Windows file systems are case-insensitive. `C:\Workspace\foo` and
//     `C:\WORKSPACE\FOO` refer to the same file. Compare lowercased real paths
//     on win32. POSIX file systems are case-sensitive (casefold only on win32).
//
// ENOENT handling: when the AI requests a path that doesn't exist yet (a
// common case for `write` targets, or for `read` on a fresh workspace), we
// fall back to `path.resolve` and check the prefix. The actual file access
// later produces ENOENT for the model — which is exactly what it would have
// gotten had we allowed it through. This is safe because:
//   - A symlink pointing outside the workspace ALWAYS exists (the symlink
//     itself is a file/dir); realpath succeeds and we follow it.
//   - For non-existent paths, there's no symlink yet to escape via.
//   - Mutate tools additionally pass through DSH sandbox kernel-level
//     containment before any disk write.

import * as path from 'node:path';
import * as fs from 'node:fs';

/** Resolve `requested` against `workspace` and confirm it sits inside, after
 *  following symlinks / junctions / Windows long-short aliases.
 *
 *  Returns false for absolute paths outside the workspace (`/etc/passwd`),
 *  relative paths that traverse up (`../../etc`), symlinks that point
 *  outside, and Windows junction-escapes. Workspace itself is included
 *  (a tool reading the workspace directory as a path passes the check).
 *
 *  Note: this is a containment check, not a permission check. Even if the
 *  returned path is inside the workspace, the actual read/write still goes
 *  through DSH's tools/pre-execute listener (where mutate tools are
 *  forced through user approval) AND, for mutate-class tools, through DSH
 *  sandbox (kernel-level containment).
 */
export function isWithinWorkspace(workspace: string, requested: string): boolean {
  if (!workspace || !requested) return false;
  // `path.resolve(workspace, requested)` resolves relative paths against the
  // workspace; absolute paths are taken as-is.
  const resolved = path.resolve(workspace, requested);
  const realWorkspace = safeRealpath(workspace);
  if (realWorkspace === null) return false;
  // Try realpath first to follow symlinks / junctions / long-short aliases.
  // If the path doesn't exist yet (write targets, fresh-workspace reads),
  // fall back to the resolved path — the file can't be a symlink yet because
  // it doesn't exist.
  const realResolved = safeRealpath(resolved) ?? resolved;
  return (
    pathEquals(realWorkspace, realResolved)
    || pathStartsWith(realResolved, realWorkspace + path.sep)
  );
}

/** `realpathSync.native` may throw for non-existent files. We swallow ENOENT
 *  (and any other I/O error) and let the caller fall back to `path.resolve`.
 *  A non-existent path cannot be a symlink to outside the workspace (no
 *  symlink exists to follow). */
function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Path equality that respects the platform's case sensitivity.
 *  Windows: case-insensitive. POSIX: case-sensitive. */
function pathEquals(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** `String.prototype.startsWith` doesn't respect platform case rules. We
 *  use a case-folded comparison on win32 so `/Workspace/foo` correctly
 *  matches the workspace `/workspace` prefix. */
function pathStartsWith(a: string, prefix: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return a.startsWith(prefix);
}

/** Pull a single string path argument out of a DSH `tools/pre-execute` exec
 *  shape. DSH fs tools accept a few aliases (`file_path` / `path` / `pattern`),
 *  and tools like `grep` carry the search root in `path` while `glob` carries
 *  it in `pattern`. We let the caller pass the key list to try in priority
 *  order. Returns undefined when nothing is a string — the caller decides
 *  whether the tool needs a path check at all. */
export function extractStringPath(
  args: unknown,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const rec = args as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
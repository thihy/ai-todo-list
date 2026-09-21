// Git history — auto-tracks every Markdown save as a commit so the editor
// can show a real, diffable, restorable history to the user.
//
// We use the OS `git` binary via execFile (no native dep) and scope the repo
// to `<rootDir>/todos/` (where the Markdown lives). On startup we run
// `git init` + a one-time local `user.name`/`user.email` config if neither
// is already set anywhere (`git config --global` first, then local fallback)
// — the commit needs an identity and the user shouldn't have to set one
// up just to make autosave work.
//
// Every API in this module returns `null` (rather than throwing) when git
// isn't available, so the rest of the app keeps working even on machines
// without git installed — the editor's history button then quietly
// disables itself.
//
// Commit messages follow "<title>: save <version>" so the log reads as a
// plain audit trail. The renderer shows the timestamp, full short SHA, and
// message; clicking an entry loads the file content at that SHA.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run `git` without flashing a console window on Windows. `git.exe` is a
 *  console-subsystem binary, so when our Electron main process (which has no
 *  console) spawns it via Node's `execFile`, Windows allocates a fresh console
 *  window for each invocation. `windowsHide` is a no-op off Windows.
 *  `encoding: 'utf8'` is set so TypeScript can pick the string-encoding
 *  overload of `execFile`; the helper has no explicit return type so the
 *  inferred narrow stdout/stderr type (`string`) flows through to callers. */
function gitExec(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
) {
  return execFileAsync('git', args, {
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 10_000,
    encoding: 'utf8',
    windowsHide: true,
  });
}

export interface GitLogEntry {
  /** Full 40-char SHA — stable across renames since we use --follow. */
  sha: string;
  /** First line of the commit message. */
  message: string;
  /** Author timestamp, ms since epoch. */
  authorTs: number;
}

export interface GitHistoryStatus {
  /** True if `git` binary was found on PATH. False disables the editor's
   *  history button. */
  available: boolean;
}

/** Detect `git` once at startup. `git --version` is the cheapest check that
 *  still distinguishes "missing" from "broken install". We don't keep the
 *  child process around — every subsequent call uses execFile. */
let gitAvailableCache: boolean | null = null;
export async function gitAvailable(): Promise<boolean> {
  if (gitAvailableCache !== null) return gitAvailableCache;
  try {
    await gitExec(['--version'], { timeout: 5000 });
    gitAvailableCache = true;
  } catch {
    gitAvailableCache = false;
  }
  return gitAvailableCache;
}

/** Run `git init` in `todosDir` if it isn't already a repo. Configures a
 *  per-repo user.name + user.email only when neither global nor local config
 *  has one — we don't want to leak defaults into the user's other repos. */
export async function ensureGitRepo(todosDir: string): Promise<void> {
  if (!(await gitAvailable())) return;
  const gitDir = join(todosDir, '.git');
  if (!existsSync(gitDir)) {
    try {
      await gitExec(['init', '--initial-branch=main'], { cwd: todosDir, timeout: 10_000 });
    } catch {
      // Older git may not support --initial-branch; fall back to plain init
      // and tolerate the branch hint being ignored.
      await gitExec(['init'], { cwd: todosDir, timeout: 10_000 });
    }
    // Ensure a sensible user identity exists *for this repo only* (no global
    // mutation). Reading first means we don't clobber a value the user set.
    await ensureLocalIdentity(todosDir);
  } else {
    // Repo already exists from a previous run — make sure the identity is
    // there. Could have been wiped if the user nuked their global config.
    await ensureLocalIdentity(todosDir);
  }
}

async function ensureLocalIdentity(todosDir: string): Promise<void> {
  try {
    const { stdout: name } = await gitExec(['config', '--get', 'user.name'], { cwd: todosDir, timeout: 5_000 });
    const { stdout: email } = await gitExec(['config', '--get', 'user.email'], { cwd: todosDir, timeout: 5_000 });
    if (name.trim() && email.trim()) return;
  } catch {
    // Neither set; fall through and write defaults.
  }
  try {
    await gitExec(['config', 'user.name', 'AI 待办'], { cwd: todosDir, timeout: 5_000 });
    await gitExec(['config', 'user.email', 'todo-list@local'], { cwd: todosDir, timeout: 5_000 });
  } catch {
    // Last-resort: leave the repo un-configured. Subsequent commits will
    // fail silently (we swallow errors in commitFile); the user will see
    // a quiet "history is empty" rather than a hard error.
  }
}

/** Stage + commit a single file in the todos/.git/ repo. Idempotent: if
 *  there's nothing to commit (the file hasn't changed since the last
 *  commit), no commit is created and the call is a no-op. Returns the new
 *  commit SHA, or null if nothing changed / git isn't available / the commit
 *  failed.
 *
 *  `relPath` is the path of the file relative to `todosDir` (the repo root),
 *  e.g. `{slug}/progress.md` after the per-task refactor. `todoTitle` +
 *  `version` only shape the commit message — they don't locate the file. */
export async function commitOnSave(
  todosDir: string,
  relPath: string,
  todoTitle: string,
  version: number,
): Promise<string | null> {
  if (!(await gitAvailable())) return null;
  const filePath = join(todosDir, relPath);
  if (!existsSync(filePath)) return null;
  try {
    // Stage the file (only — leaving other working-tree changes alone).
    await gitExec(['add', '--', relPath], { cwd: todosDir, timeout: 10_000 });
    // `--allow-empty` would defeat the no-change short-circuit, but we
    // don't want empty commits polluting the log, so use `git diff --cached
    // --quiet` to detect "nothing to commit" first.
    const { stdout: diffCached } = await gitExec(
      ['diff', '--cached', '--quiet', '--', relPath],
      { cwd: todosDir, timeout: 5_000 },
    ).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      // exit code 1 from `diff --quiet` means "files differ" — i.e. there
      // IS something to commit, which is what we want. The promisified
      // execFile stamps the numeric exit code onto `err.code` as a
      // number, which collides with NodeJS.ErrnoException's `code?: string`.
      // Cast through unknown so we can compare to 1 safely.
      const exitCode = (err as unknown as { code?: unknown }).code;
      if (exitCode === 1) return { stdout: 'differ', stderr: '' };
      throw err;
    });
    if (diffCached === '') return null; // truly empty
  } catch {
    return null;
  }
  try {
    const message = `${todoTitle}: save ${version}`;
    // `-c` is unnecessary since we set local identity; using --only is more
    // explicit but only works with a path; with `git commit -- file` we
    // stage ONLY that path's diff into the commit even if other files were
    // also staged above — safe + obvious.
    await gitExec(['commit', '-m', message, '--', relPath], { cwd: todosDir, timeout: 10_000 });
    const { stdout: sha } = await gitExec(['rev-parse', 'HEAD'], { cwd: todosDir, timeout: 5_000 });
    return sha.trim();
  } catch {
    return null;
  }
}

/** Read the commit log for a single file, newest-first. Uses `--follow` so
 *  renames stay linked across the v1→v2 layout migration (the bridge commit
 *  recorded via git-history.mv keeps `--follow` working when the file moved
 *  from `{ulid}.md` to `{slug}/progress.md`). `limit` defaults to 100. */
export async function getFileLog(
  todosDir: string,
  relPath: string,
  limit = 100,
): Promise<GitLogEntry[] | null> {
  if (!(await gitAvailable())) return null;
  if (!existsSync(join(todosDir, '.git'))) return [];
  try {
    // Custom format: SHA + author timestamp + subject (%s), tab-separated so
    // we don't have to worry about newlines/messages containing our separator.
    const fmt = '%H%x09%at%x09%s';
    const { stdout } = await gitExec(
      ['log', '--follow', `--pretty=${fmt}`, '-n', String(limit), '--', relPath],
      { cwd: todosDir, timeout: 10_000 },
    );
    if (!stdout.trim()) return [];
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, ...rest] = line.split('\t');
        return {
          sha: sha!,
          authorTs: Number(at) * 1000,
          message: rest.join('\t'),
        };
      });
  } catch {
    return null;
  }
}

/** Read the file's content at a given commit SHA. Used to populate the
 *  history popover's preview / restore target. Returns null if git isn't
 *  available or the SHA is unknown to the repo. */
export async function getFileAtSha(
  todosDir: string,
  relPath: string,
  sha: string,
): Promise<string | null> {
  if (!(await gitAvailable())) return null;
  try {
    const { stdout } = await gitExec(
      ['show', `${sha}:${relPath}`],
      { cwd: todosDir, timeout: 10_000 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/** Restore the working tree's copy of the file to a given commit. Writes
 *  the file directly (we DON'T checkout — that would touch the whole
 *  working tree). Used by the history popover's "恢复此版本" action.
 *
 *  Post-refactor the file is raw Markdown (progress.md) with no front-matter,
 *  so the restored bytes are written verbatim. */
export async function restoreFileAtSha(
  todosDir: string,
  relPath: string,
  sha: string,
): Promise<boolean> {
  if (!(await gitAvailable())) return false;
  try {
    const { stdout } = await gitExec(
      ['show', `${sha}:${relPath}`],
      { cwd: todosDir, timeout: 10_000 },
    );
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const abs = join(todosDir, relPath);
    // The target dir may not exist yet if the task dir was removed; recreate
    // it so the restore lands where the editor expects to find the file.
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stdout, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Rename (or add) a single path inside the todos/.git/ repo. Used by the
 *  v1→v2 migration sweep to keep `git log --follow` working across the
 *  layout change. Returns true when the move staged something — false when
 *  git isn't available, the source doesn't exist, or git refused (e.g.
 *  because the source wasn't tracked). All errors are swallowed. */
export async function mv(
  todosDir: string,
  fromRelPath: string,
  toRelPath: string,
): Promise<boolean> {
  if (!(await gitAvailable())) return false;
  if (!existsSync(join(todosDir, '.git'))) return false;
  try {
    await gitExec(
      ['mv', '--', fromRelPath, toRelPath],
      { cwd: todosDir, timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Internal helper for the renderer hint about file-relative paths. Not
 *  exported. Kept for future per-task sub-repo work if we ever decide
 *  each task should have its own .git/ to keep history scoped tighter. */
export function _relativePath(absolute: string, base: string): string {
  const r = relative(base, absolute);
  return r.split(sep).join('/');
}
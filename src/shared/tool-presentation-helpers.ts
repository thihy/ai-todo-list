// Tool-result projection for DSH fs / shell tools. Maps the raw envelope that
// `dsh-tool-fs` / `dsh-tool-bash` / `dsh-tool-pwsh` / `dsh-tool-fs-search`
// return to the UI's ToolResultView shape — so `presentToolResult` can route
// read → ReadBlock, write/edit → DiffBlock, grep/glob → SearchBlock,
// bash/pwsh → TerminalBlock without falling back to JsonBlock.
//
// Each helper tolerates malformed envelopes: a missing field returns a minimal
// shape that the UI primitive renders without crashing. The renderer would
// still display something useful; we never throw out of `presentToolResult`.
// (See OPENSPEC §ai-assistant Filesystem and shell tools registered with DSH.)
//
// Wire shapes observed in practice (DSH 0.1.5-rc.2):
//   read      → { output: string }  (text already formatted as "<line>│<text>")
//   read_image→ { base64, mime }
//   grep      → { output: string }  (text formatted "<path>:<line>:<text>")
//   glob      → string[] | { files: string[] }
//   write     → { ok: true, file_path, bytesWritten }
//   edit      → { ok: true, file_path, ... }
//   bash      → { output: string, exitCode, ... } (output is the combined stdout+stderr)
//   pwsh      → same as bash
//
// We avoid a hard dependency on the tool package's return type by accepting
// `unknown` and doing best-effort field reads.

import type { ToolResultView, ReadFileLine, FileDiff } from '@deepseek-ai/dsh-tools';

// ─── read / read_image ─────────────────────────────────────────────────────

/** Parse a DSH read-tool result envelope (or shape string with optional line-number
 *  prefix) into a ReadBlock payload. */
export function readResultToView(_args: unknown, result: unknown): ToolResultView {
  const path = stringField(result, 'file_path')
    ?? stringField(result, 'path')
    ?? stringField(_args, 'file_path')
    ?? stringField(_args, 'path')
    ?? 'unknown';
  const output = stringField(result, 'output');
  const explicitLines = arrayField(result, 'lines') as ReadFileLine[] | undefined;
  const lines: ReadFileLine[] = explicitLines && explicitLines.length > 0
    ? explicitLines
    : output !== undefined
      ? parseNumberedLines(output)
      : [];
  return {
    card: 'read',
    title: '读取',
    path,
    offset: 1,
    lines,
    totalLines: lines.length,
  };
}

/** DSH read prints lines as "<number>│<text>" (a vertical bar separator); we
 *  split on the first occurrence so `<text>` is allowed to contain bars. */
function parseNumberedLines(output: string): ReadFileLine[] {
  const lines: ReadFileLine[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (raw === '') continue;
    const idx = raw.indexOf('│');
    if (idx === -1) {
      lines.push({ number: lines.length + 1, text: raw });
      continue;
    }
    const numStr = raw.slice(0, idx).trim();
    const text = raw.slice(idx + 1);
    const n = Number.parseInt(numStr, 10);
    lines.push(Number.isFinite(n) ? { number: n, text } : { number: lines.length + 1, text });
  }
  return lines;
}

// ─── write / edit ──────────────────────────────────────────────────────────

/** Parse a DSH write/edit tool result into a DiffBlock payload. The old/new
 *  text comes from the args (write) or from result.oldText/newText (edit). */
export function writeEditToView(toolName: 'write' | 'edit', args: unknown, result: unknown): ToolResultView {
  const filePath = stringField(args, 'file_path')
    ?? stringField(result, 'file_path')
    ?? stringField(result, 'path')
    ?? 'unknown';
  const newText = toolName === 'write'
    ? stringField(args, 'content') ?? ''
    : stringField(result, 'newText') ?? stringField(args, 'new_string') ?? stringField(args, 'new_text') ?? '';
  // DSH write / edit both run under host approval — we don't have the old
  // text handy on the wire (the tools return success envelopes). Render as
  // a single all-additions diff so the user sees what landed. DiffBlock
  // accepts `oldText: null` and treats the whole new content as a replace.
  const oldText = stringField(result, 'oldText')
    ?? (toolName === 'edit' ? stringField(args, 'old_string') ?? stringField(args, 'old_text') ?? null : null);
  const diff: FileDiff = { path: filePath, oldText, newText };
  return {
    card: 'diff',
    title: `${toolName === 'write' ? '写入' : '编辑'} ${filePath}`,
    diffs: [diff],
  };
}

// ─── grep ──────────────────────────────────────────────────────────────────

/** Parse a DSH grep result envelope into a SearchMatchesResultView payload
 *  (`shape: 'matches'`, matches grouped by file). DSH grep text format:
 *  "<file>:<line>:<text>" per match. */
export function grepResultToView(args: unknown, result: unknown): ToolResultView {
  const pattern = stringField(args, 'pattern') ?? '';
  const path = stringField(args, 'path') ?? '';
  const output = stringField(result, 'output') ?? '';
  const lines = output === '' ? [] : output.split(/\r?\n/).filter((l) => l.length > 0);
  // Group matches by their file (first colon-separated field). Files keep
  // first-seen order via insertion into the map.
  const groups = new Map<string, { lineNumber: number; line: string }[]>();
  for (const raw of lines) {
    const match = /^(.*?):(\d+):(.*)$/.exec(raw);
    let file: string;
    let lineNum: number;
    let text: string;
    if (!match) {
      file = path || '(unknown)';
      lineNum = 1;
      text = raw;
    } else {
      file = match[1];
      lineNum = Number(match[2]);
      text = match[3];
    }
    const arr = groups.get(file) ?? [];
    arr.push({ lineNumber: lineNum, line: text });
    groups.set(file, arr);
  }
  const files = Array.from(groups.entries()).map(([filePath, matches]) => ({
    path: filePath,
    matches,
  }));
  const totalCount = files.reduce((n, f) => n + f.matches.length, 0);
  return {
    card: 'search',
    shape: 'matches',
    title: `grep · ${pattern}`,
    files,
    truncated: false,
    total: totalCount,
  };
}

// ─── glob ──────────────────────────────────────────────────────────────────

/** Parse a DSH glob result envelope into a SearchPathsResultView payload
 *  (`shape: 'paths'`, a flat path list — DSH unpack end expects this for the
 *  discovery primitive). */
export function globResultToView(args: unknown, result: unknown): ToolResultView {
  const pattern = stringField(args, 'pattern') ?? '';
  // Two shapes observed: array of strings, or { files: string[] }.
  const paths: string[] = Array.isArray(result)
    ? result.filter((s): s is string => typeof s === 'string')
    : (arrayField(result, 'files') as string[] | undefined)?.filter((s): s is string => typeof s === 'string')
      ?? (arrayField(result, 'paths') as string[] | undefined)?.filter((s): s is string => typeof s === 'string')
        ?? [];
  return {
    card: 'search',
    shape: 'paths',
    title: `glob · ${pattern}`,
    paths,
    truncated: false,
    total: paths.length,
  };
}

// ─── bash / pwsh ───────────────────────────────────────────────────────────

/** Parse a DSH bash/pwsh result envelope into a TerminalResultView payload.
 *  DSH's TerminalResultView has a single `output` field (stdout+stderr
 *  merged as the tool chooses to combine them); we also forward `exitCode`
 *  so the UI primitive can show the exit-status chip. */
export function bashToView(toolName: 'bash' | 'pwsh', args: unknown, result: unknown): ToolResultView {
  const command = stringField(args, 'command') ?? stringField(args, 'script') ?? '';
  if (typeof result === 'string') {
    const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(result);
    const exit = /\n\[exit code: (\d+)\]$/.exec(result);
    const marker = signal ?? exit;
    return {
      card: 'terminal', title: `${toolName} · ${truncate(command, 60)}`,
      output: marker ? result.slice(0, marker.index) : result,
      ...(signal ? { signal: signal[1] } : { exitCode: exit ? Number(exit[1]) : 0 }),
    };
  }
  const envelope = result as { stdout?: unknown; stderr?: unknown; timedOut?: boolean; timeoutMs?: number } | null;
  const stdout = stringField(result, 'output')
    ?? stringField(result, 'stdout')
    ?? stringField(envelope?.stdout, 'text')
    ?? '';
  const stderr = stringField(result, 'stderr') ?? stringField(envelope?.stderr, 'text') ?? '';
  const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
    + (envelope?.timedOut ? `\n[timed out after ${envelope.timeoutMs}ms]` : '');
  const exitCode = numberField(result, 'exitCode');
  const signal = stringField(result, 'signal');
  return {
    card: 'terminal',
    title: `${toolName === 'bash' ? 'bash' : 'pwsh'} · ${truncate(command, 60)}`,
    ...(output !== '' ? { output } : {}),
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
  };
}

// ─── tiny data-shape helpers ───────────────────────────────────────────────

function stringField(v: unknown, key: string): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = (v as Record<string, unknown>)[key];
  return typeof x === 'string' ? x : undefined;
}

function numberField(v: unknown, key: string): number | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = (v as Record<string, unknown>)[key];
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function arrayField(v: unknown, key: string): unknown[] | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const x = (v as Record<string, unknown>)[key];
  return Array.isArray(x) ? x : undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

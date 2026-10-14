// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { handlePreExecute } from '../../src/main/dsh/dsh-runtime';
import { directoryList, validateFileAccessPatch } from '../../src/main/dsh/file-access';
import { isWithinWorkspace } from '../../src/main/dsh/path-guard';

const root = mkdtempSync(join(tmpdir(), 'external-access-'));
const workspace = join(root, 'workspace');
const allowed = join(root, 'allowed');
const secret = join(root, 'secret');
for (const dir of [workspace, allowed, secret]) mkdirSync(dir);
afterEach(() => vi.restoreAllMocks());
import { afterAll } from 'vitest';
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function gate(preset: string, path: string, options = {}, name = 'read') {
  const next = vi.fn().mockResolvedValue({ kind: 'allow' });
  const result = await handlePreExecute({ name, arguments: { file_path: path, command: 'Get-Content outside.txt' } } as never, next,
    { settings: { get: () => ({ dshWorkspaceDir: workspace, ...options }) }, currentPreset: () => preset });
  return { result, next };
}

describe('external file access', () => {
  it('keeps restricted and Auto reads denied by default', async () => {
    for (const preset of ['auto', 'read-only']) expect((await gate(preset, secret)).result.kind).toBe('deny');
  });
  it('honors full access for reads and commands', async () => {
    for (const tool of ['read', 'read_image', 'grep', 'glob', 'write', 'edit', 'pwsh', 'bash']) {
      expect((await gate('danger-full-access', secret, {}, tool)).next).toHaveBeenCalledOnce();
    }
  });
  it('asks per invocation for external reads including Auto', async () => {
    for (const preset of ['auto', 'read-only']) {
      const { result, next } = await gate(preset, secret, { externalFileAccess: 'ask' });
      expect(result.kind).toBe('ask');
      expect(next).not.toHaveBeenCalled();
    }
  });
  it('allows whitelist descendants and relative paths resolved from workspace', async () => {
    for (const path of [join(allowed, 'file.md'), relative(workspace, join(allowed, 'file.md'))]) {
      expect((await gate('auto', path, { externalReadDirs: [allowed] })).next).toHaveBeenCalledOnce();
    }
  });
  it('does not reinterpret workspace-relative paths against whitelist roots', async () => {
    expect((await gate('auto', '../secret/file.md', { externalReadDirs: [allowed] })).result.kind).toBe('deny');
  });
  it('allows skill resources without authorizing unrelated directories', async () => {
    expect((await gate('read-only', join(allowed, 'references', 'guide.md'), { skillDirs: [allowed] })).next).toHaveBeenCalledOnce();
    expect((await gate('read-only', secret, { skillDirs: [allowed] })).result.kind).toBe('deny');
  });
  it('asks for Auto shell commands when external confirmation is enabled', async () => {
    expect((await gate('auto', secret, { externalFileAccess: 'ask' }, 'pwsh')).result.kind).toBe('ask');
  });
  it('whitelist does not grant writes under restricted modes', async () => {
    expect((await gate('read-only', allowed, { externalReadDirs: [allowed] }, 'write')).result.kind).toBe('ask');
  });
  it('rejects existing and missing descendants behind a junction escape', () => {
    writeFileSync(join(secret, 'present.md'), 'secret');
    const link = join(allowed, 'escape');
    symlinkSync(secret, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isWithinWorkspace(allowed, join(link, 'present.md'))).toBe(false);
    expect(isWithinWorkspace(allowed, join(link, 'missing', 'file.md'))).toBe(false);
  });
});

describe('directory settings validation', () => {
  it('expands standard home paths and deduplicates', () => {
    expect(directoryList([' ~/.agents/skills ', '~/.agents/skills'])).toEqual([join(homedir(), '.agents', 'skills')]);
  });
  it('rejects invalid mode, relative paths, nonstrings and NUL', () => {
    for (const value of [['relative'], [42], ['C:\\bad\0path'], 'root']) expect(() => directoryList(value)).toThrow();
    expect(() => validateFileAccessPatch({ externalFileAccess: 'allow' } as never)).toThrow();
  });
});

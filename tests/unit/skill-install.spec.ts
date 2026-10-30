import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installLocalSkill } from '../../src/main/skills/install';

let root: string; let source: string; let destination: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-install-')); source = join(root, 'source', 'example-skill'); destination = join(root, 'installed');
  mkdirSync(source, { recursive: true }); mkdirSync(join(source, 'references'));
  writeFileSync(join(source, 'SKILL.md'), '---\nname: example-skill\ndescription: Example skill\n---\nUse the guide.');
  writeFileSync(join(source, 'references', 'guide.md'), 'local resource');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('native DSH Skill installation', () => {
  it('validates with native provider and preserves companion resources without overwriting', async () => {
    const installed = await installLocalSkill(source, destination);
    expect(installed.name).toBe('example-skill');
    expect(readFileSync(join(installed.path, 'references', 'guide.md'), 'utf8')).toBe('local resource');
    await expect(installLocalSkill(source, destination)).rejects.toThrow('已存在');
    expect(readFileSync(join(installed.path, 'references', 'guide.md'), 'utf8')).toBe('local resource');
  });
  it('rejects malformed skills before writing a destination', async () => {
    writeFileSync(join(source, 'SKILL.md'), 'no metadata');
    await expect(installLocalSkill(source, destination)).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
    await expect(installLocalSkill('relative', destination)).rejects.toThrow('绝对路径');
  });
  it('rejects junction content without following it', async () => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(source, 'linked'), 'junction');
    await expect(installLocalSkill(source, destination)).rejects.toThrow('符号链接');
    expect(existsSync(destination)).toBe(false);
  });
});

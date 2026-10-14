// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';

describe('standard Agent Skills directories', () => {
  it('discovers and loads real user, project and custom skill bundles with the shipped configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standard-skills-'));
    const userHome = join(root, 'home');
    const project = join(root, 'project');
    const extra = join(root, 'extra');
    const config = readFileSync(resolve('resources/dsh/cordis.yml'), 'utf8');
    const expression = config.match(/agentsHome: !!js "([^"]+)"/)?.[1];
    expect(expression).toBeDefined();
    const agentsHome = new Function('process', `return ${expression}`)({ env: { USERPROFILE: userHome, HOME: userHome } });
    expect(resolve(agentsHome)).toBe(join(userHome, '.agents'));
    for (const [base, name] of [[join(userHome, '.agents', 'skills'), 'user-example'], [join(project, '.agents', 'skills'), 'project-example'], [extra, 'extra-example']]) {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Example skill\n---\nLoaded ${name}`);
    }
    mkdirSync(join(project, '.git'));
    const provider = new FileSystemSkillProvider({ get: () => undefined, logger: { warn: vi.fn() } } as never,
      { invalidate: vi.fn(), signal: new AbortController().signal } as never,
      { agentsHome, dshHome: join(root, 'dsh'), customSkillDirs: [extra], watch: false } as never);
    try {
      const listing = await provider.list({ cwd: project } as never);
      const candidates = Array.isArray(listing) ? listing : listing.candidates;
      expect(candidates.map((candidate) => candidate.name).sort()).toEqual(['extra-example', 'project-example', 'user-example']);
      for (const candidate of candidates) {
        const skill = await provider.get(candidate, {} as never);
        expect(skill?.content).toBe(`Loaded ${candidate.name}`);
      }
    } finally {
      await provider.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

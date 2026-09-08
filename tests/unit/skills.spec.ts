// Skills registry: default skills are enabled and enabledToolsFor is the union.

import { describe, it, expect } from 'vitest';
import {
  SKILLS,
  enabledToolsFor,
  defaultEnabledSkills,
  composeSystemPrompt,
} from '../../src/main/dsh/skills';

describe('Skills', () => {
  it('default-enabled skills include todo-ops and analysis', () => {
    const ids = defaultEnabledSkills();
    expect(ids).toContain('todo-ops');
    expect(ids).toContain('analysis');
  });

  it('drawing-ops is not enabled by default', () => {
    expect(defaultEnabledSkills()).not.toContain('drawing-ops');
  });

  it('enabledToolsFor unions tools across selected skills', () => {
    const tools = enabledToolsFor(['todo-ops', 'content-ops']);
    expect(tools).toContain('todo.list');
    expect(tools).toContain('content.writeBody');
    expect(tools).not.toContain('drawing.save');
  });

  it('composeSystemPrompt concatenates enabled fragments', () => {
    const prompt = composeSystemPrompt(['todo-ops', 'content-ops']);
    expect(prompt).toContain('TODO');
    expect(prompt).toContain('Markdown');
  });

  it('every skill has a unique id and a non-empty tool list', () => {
    const ids = new Set<string>();
    for (const s of SKILLS) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.tools.length).toBeGreaterThan(0);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
  });
});
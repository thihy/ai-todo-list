// resumeOrCreate — pure helper that decides between `agents.resume()` (the
// safe path for an existing persisted session) and `agents.create()` (only
// when the backend confirms the id is genuinely absent on disk).
//
// Why this matters: calling `create()` on an id that already has a persisted
// session log throws "id collision" deep inside DSH's persistence coordinator
// (coordinator.ts:1256). The throw is silently swallowed, but the next
// loadHistory() call from the renderer surfaces it as
// `loadHistory(id) failed: ... (id collision)`. The three branches below pin
// the contract so a future change to ensureAgent can't silently re-introduce
// the regression.

import { describe, it, expect, vi } from 'vitest';
import { resumeOrCreate, type AgentHandle, type AgentsFacade, type PersistenceFacade, type ResumeLogger } from '../../src/main/dsh/dsh-runtime';

const convId = '01M24ANKP4HWKZ7Z7XQCHG8X2W';

function makeHandle(label: string): AgentHandle {
  return {
    agent: {
      followup: vi.fn(),
      whenIdle: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      id: `${label}-agent`,
    },
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger(): ResumeLogger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    warn: (msg) => { warns.push(msg); },
    info: (msg) => { infos.push(msg); },
  };
}

/** Build an agents facade that records calls and returns scripted outcomes. */
function makeAgents(opts: {
  resumeOutcome?: 'ok' | 'throw';
  createOutcome?: 'ok' | 'throw';
} = {}): AgentsFacade & {
  resumeCalls: unknown[];
  createCalls: unknown[];
} {
  const resumeCalls: unknown[] = [];
  const createCalls: unknown[] = [];
  const resumeHandle = makeHandle('resume');
  const createHandle = makeHandle('create');
  return {
    resumeCalls,
    createCalls,
    async resume(o) {
      resumeCalls.push(o);
      if (opts.resumeOutcome === 'throw') throw new Error('session not found');
      return resumeHandle;
    },
    async create(o) {
      createCalls.push(o);
      if (opts.createOutcome === 'throw') throw new Error('agent already registered');
      return createHandle;
    },
  };
}

function makePersistence(headers: Array<{ id: string; createdAt?: number }>): PersistenceFacade {
  return {
    async list() { return headers; },
    async load() { return undefined; },
  };
}

describe('resumeOrCreate', () => {
  it('returns the resume() handle when resume succeeds (the common happy path)', async () => {
    const agents = makeAgents({ resumeOutcome: 'ok' });
    const persistence = makePersistence([{ id: convId }]);
    const logger = makeLogger();
    const handle = await resumeOrCreate(
      { agents, persistence, logger },
      convId,
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    expect(handle.agent.id).toBe('resume-agent');
    expect(agents.resumeCalls).toEqual([{ resumeSessionId: convId, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } }]);
    expect(agents.createCalls).toEqual([]);
    expect(logger.warns).toEqual([]);
    expect(logger.infos).toEqual([]);
  });

  it('falls back to create() only when persistence.list() confirms the id is absent', async () => {
    // Resume throws "session not found" — the legitimate "no log on disk" reason.
    const agents = makeAgents({ resumeOutcome: 'throw' });
    const persistence = makePersistence([{ id: 'some-other-id' }]); // convId NOT in list
    const logger = makeLogger();
    const handle = await resumeOrCreate(
      { agents, persistence, logger },
      convId,
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    expect(handle.agent.id).toBe('create-agent');
    expect(agents.createCalls).toEqual([{ sessionId: convId, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } }]);
    expect(logger.infos).toEqual([expect.stringContaining('no persisted session; creating fresh agent')]);
    expect(logger.warns).toEqual([]);
  });

  it('rethrows the resume error when persistence.list() shows the id EXISTS — never clobbers a broken log', async () => {
    // Resume throws (corruption / format mismatch / backend read failure),
    // AND persistence.list() confirms the id has a stored log. We must NOT
    // fall back to create() — that would start an empty session and
    // overwrite the broken one on the first append.
    const agents = makeAgents({ resumeOutcome: 'throw' });
    const persistence = makePersistence([{ id: convId }]);
    const logger = makeLogger();
    await expect(
      resumeOrCreate(
        { agents, persistence, logger },
        convId,
        { provider: 'deepseek', model: 'deepseek-chat' },
      ),
    ).rejects.toThrow(/session not found/);
    expect(agents.createCalls).toEqual([]);
    expect(logger.warns.some((w) => w.includes('resume failed for an existing persisted session'))).toBe(true);
  });

  it('rethrows the resume error when persistence.list() itself fails — cannot decide safely', async () => {
    const agents = makeAgents({ resumeOutcome: 'throw' });
    const persistence: PersistenceFacade = {
      async list() { throw new Error('backend timeout'); },
    };
    const logger = makeLogger();
    await expect(
      resumeOrCreate(
        { agents, persistence, logger },
        convId,
        { provider: 'deepseek', model: 'deepseek-chat' },
      ),
    ).rejects.toThrow(/session not found/);
    expect(agents.createCalls).toEqual([]);
    expect(logger.warns.some((w) => w.includes('persistence.list() failed during fallback probe'))).toBe(true);
  });

  it('treats the absence of persistence.list() as "unknown" and rethrows the resume error', async () => {
    // No persistence at all (e.g. DSH booted without a backend — shouldn't
    // happen in production but the helper must not crash either way).
    const agents = makeAgents({ resumeOutcome: 'throw' });
    const logger = makeLogger();
    await expect(
      resumeOrCreate(
        { agents, persistence: undefined, logger },
        convId,
        { provider: 'deepseek', model: 'deepseek-chat' },
      ),
    ).rejects.toThrow(/session not found/);
    expect(agents.createCalls).toEqual([]);
  });
});
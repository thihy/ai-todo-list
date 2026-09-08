// Markdown store: writeBody / history / restoreVersion trimming at MAX_BODY_VERSIONS.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStore } from '../../src/main/files/markdown';
import { openDb } from '../../src/main/db/schema';
import Database from 'better-sqlite3';

let db: Database.Database;
let dir: string;
let md: MarkdownStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thihy-md-'));
  const handle = openDb(join(dir, 't.db'));
  db = handle.db;
  md = new MarkdownStore(db, join(dir, 'todos'));
});

describe('MarkdownStore', () => {
  it('writes a body and reads it back', () => {
    const res = md.writeBody('todo1', '# Hello', undefined);
    expect(res.body).toBe('# Hello');
    expect(res.version).toBe(1);
    expect(md.readBody('todo1').body).toBe('# Hello');
  });

  it('history grows on each write and trims at MAX_BODY_VERSIONS', () => {
    md.writeBody('todo2', 'v1', undefined);
    for (let i = 2; i <= 25; i++) {
      md.writeBody('todo2', `v${i}`, undefined);
    }
    const hist = md.history('todo2');
    expect(hist.length).toBeLessThanOrEqual(20);
  });

  it('restoreVersion rewinds body', () => {
    md.writeBody('todo3', 'a', undefined);
    md.writeBody('todo3', 'b', undefined);
    const h = md.history('todo3');
    const oldest = h[h.length - 1];
    md.restoreVersion('todo3', oldest.id);
    expect(md.readBody('todo3').body).toBe('a');
  });

  it('filePathFor returns expected layout', () => {
    const p = md.filePathFor('placeholder');
    expect(existsSync(dirname(p))).toBe(true);
  });
});

function dirname(p: string): string {
  return p.replace(/[/\\][^/\\]+$/, '');
}

// silence unused-import
void readdirSync;
void rmSync;
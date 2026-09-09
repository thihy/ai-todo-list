// @deepseek-ai/dsh-web-frontend resolution smoke check.
//
// The dsh-web:// protocol handler in main/index.ts uses createRequire to
// resolve this package and serve its dist/ via the iframe. If anyone removes
// the dep, upgrades past a version that drops `exports: { "./dist/*" }`, or
// the dist layout drifts, the AIPanel iframe falls back to a placeholder
// page. Pin the expectations here so the failure is loud at test time, not a
// silent "AI panel shows nothing" in the user's window.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

const req = createRequire(import.meta.url);

describe('@deepseek-ai/dsh-web-frontend dist layout', () => {
  it('resolves package.json via createRequire (honors exports map)', () => {
    let pkgPath: string | undefined;
    expect(() => {
      pkgPath = req.resolve('@deepseek-ai/dsh-web-frontend/package.json');
    }).not.toThrow();
    expect(pkgPath).toBeDefined();
    // Path separator agnostic — Windows resolves to backslashes, POSIX to slashes.
    expect(pkgPath!.replace(/\\/g, '/').endsWith('dsh-web-frontend/package.json')).toBe(true);
  });

  it('sits a populated dist/ next to package.json', () => {
    const pkgPath = req.resolve('@deepseek-ai/dsh-web-frontend/package.json');
    const distDir = join(dirname(pkgPath), 'dist');
    expect(existsSync(join(distDir, 'index.html'))).toBe(true);
    const stat = statSync(distDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('ships the assets/ subdir that index.html references', () => {
    const pkgPath = req.resolve('@deepseek-ai/dsh-web-frontend/package.json');
    const assetsDir = join(dirname(pkgPath), 'dist', 'assets');
    expect(existsSync(assetsDir)).toBe(true);
    const entries = readdirSync(assetsDir);
    expect(entries.some((e) => e.endsWith('.js'))).toBe(true);
    expect(entries.some((e) => e.endsWith('.css'))).toBe(true);
  });
});
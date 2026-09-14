import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('packaged DSH resources', () => {
  it('copies the DSH configuration beside app.asar', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };

    expect(pkg.build?.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'resources/dsh', to: 'dsh' }),
    ]));
  });
});

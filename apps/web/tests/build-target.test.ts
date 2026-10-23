import { readFileSync } from 'node:fs';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import { describe, expect, it } from 'vitest';
import { buildTarget } from '../vite.config';

describe('[FR-041] build target', () => {
  it('equals the targets derived from the package browserslist', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { browserslist: string[] };

    expect(buildTarget).toEqual(browserslistToEsbuild(pkg.browserslist));
    expect(buildTarget.length).toBeGreaterThan(0);
  });
});

// The bundle budget (ADR-0012, research R21): the initial JS (entry plus its static
// imports) and each lazy route chunk, gzip-measured from Vite's manifest.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BUNDLE_BUDGET_KB, checkBundleBudget, measureBundle } from '../check-bundle-budget.mjs';

// A small Vite build written at run time: random content doesn't compress, so gzip sizes
// are predictable (base64 of n random bytes gzips to roughly 0.76 n bytes).
const DIST = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
after(() => rmSync(DIST, { recursive: true, force: true }));

const MANIFEST = {
  'index.html': {
    file: 'assets/entry.js',
    src: 'index.html',
    isEntry: true,
    imports: ['_shared.js'],
    dynamicImports: ['src/pages/Home.tsx', 'src/pages/Reports.tsx'],
    css: ['assets/entry.css'],
  },
  '_shared.js': { file: 'assets/shared.js', imports: ['_tiny.js'] },
  '_tiny.js': { file: 'assets/tiny.js' },
  '_charts.js': { file: 'assets/charts.js' },
  'src/pages/Home.tsx': {
    file: 'assets/home.js',
    src: 'src/pages/Home.tsx',
    isDynamicEntry: true,
    imports: ['_shared.js'],
  },
  'src/pages/Reports.tsx': {
    file: 'assets/reports.js',
    src: 'src/pages/Reports.tsx',
    isDynamicEntry: true,
    imports: ['_shared.js', '_charts.js'],
  },
};
const RANDOM_BYTES = { entry: 3000, shared: 2000, charts: 6000, home: 1000, reports: 1000 };

mkdirSync(join(DIST, '.vite'), { recursive: true });
mkdirSync(join(DIST, 'assets'));
writeFileSync(join(DIST, '.vite/manifest.json'), JSON.stringify(MANIFEST));
for (const [name, bytes] of Object.entries(RANDOM_BYTES)) {
  writeFileSync(join(DIST, `assets/${name}.js`), randomBytes(bytes).toString('base64'));
}
writeFileSync(join(DIST, 'assets/tiny.js'), 'export const t = 1;\n');
writeFileSync(join(DIST, 'assets/entry.css'), 'body { margin: 0; }\n');

describe('[NFR-FE-06] bundle budget', () => {
  it('[NFR-FE-06] the budget is ADR-0012s: 200 KB initial, 150 KB per lazy chunk', () => {
    assert.deepEqual(BUNDLE_BUDGET_KB, { initial: 200, lazyChunk: 150 });
  });

  it('[NFR-FE-06] measures the entry with its static imports, and each lazy chunk without what the entry already loads', () => {
    const sizes = measureBundle(DIST);
    assert.deepEqual(sizes.initialFiles, ['assets/entry.js', 'assets/shared.js', 'assets/tiny.js']);
    assert.deepEqual(
      sizes.lazyChunks.map((c) => [c.name, c.files]),
      [
        ['src/pages/Home.tsx', ['assets/home.js']],
        ['src/pages/Reports.tsx', ['assets/reports.js', 'assets/charts.js']],
      ],
    );
    assert.ok(sizes.initialKb > 4 && sizes.initialKb < 8, String(sizes.initialKb));
  });

  it('[NFR-FE-06] passes under the budget', () => {
    assert.deepEqual(checkBundleBudget(DIST, BUNDLE_BUDGET_KB).errors, []);
  });

  it('[NFR-FE-06] fails when the initial JS is over', () => {
    const { errors } = checkBundleBudget(DIST, { initial: 3, lazyChunk: 150 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /initial/);
  });

  it('[NFR-FE-06] fails, naming the chunk, when a lazy chunk is over', () => {
    const { errors } = checkBundleBudget(DIST, { initial: 200, lazyChunk: 5 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /src\/pages\/Reports\.tsx/);
  });
});

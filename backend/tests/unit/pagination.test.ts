import { describe, expect, it } from 'vitest';
import { pageArgs, toPage } from '../../src/lib/pagination.js';

describe('[NFR-PERF-01] list pagination helpers', () => {
  it('[NFR-PERF-01] page 1 starts at offset 0; page n skips n-1 pages', () => {
    expect(pageArgs({ page: 1, pageSize: 25 })).toEqual({ offset: 0, limit: 25 });
    expect(pageArgs({ page: 4, pageSize: 10 })).toEqual({ offset: 30, limit: 10 });
  });

  it('[NFR-PERF-01] the page maps each row and carries the query and the total', () => {
    const page = toPage(
      { page: 2, pageSize: 2 },
      { rows: [1, 2], total: 7 },
      (n) => `#${String(n)}`,
    );
    expect(page).toEqual({ items: ['#1', '#2'], page: 2, pageSize: 2, total: 7 });
  });

  it('[NFR-PERF-01] the mapper gets only the row, not its index', () => {
    const seen: unknown[][] = [];
    toPage({ page: 1, pageSize: 5 }, { rows: ['a'], total: 1 }, (...args: unknown[]) => {
      seen.push(args);
      return args[0];
    });
    expect(seen).toEqual([['a']]);
  });
});

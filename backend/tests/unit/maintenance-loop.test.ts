import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMaintenanceLoop } from '../../src/maintenance/loop.js';
import { runPurgeCycle, type PurgeTask } from '../../src/maintenance/purge.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

const db = {} as never;

describe('[NFR-OPS-05] maintenance loop skeleton', () => {
  it('[NFR-OPS-05] logs one "purge run complete" line with per-task counts', async () => {
    const { logger, lines } = capture();
    const tasks: PurgeTask[] = [
      { name: 'audit_entries', run: () => Promise.resolve(3) },
      { name: 'one_time_tokens', run: () => Promise.resolve(0) },
    ];
    await expect(runPurgeCycle(tasks, db, logger)).resolves.toEqual({
      counts: { audit_entries: 3, one_time_tokens: 0 },
      failed: [],
    });
    const done = lines.filter((l) => l['msg'] === 'purge run complete');
    expect(done).toHaveLength(1);
    expect(done[0]?.['tables']).toEqual([
      { table: 'audit_entries', deleted: 3 },
      { table: 'one_time_tokens', deleted: 0 },
    ]);
  });

  it('[NFR-OPS-05] logs an empty table list when nothing is registered', async () => {
    const { logger, lines } = capture();
    await runPurgeCycle([], db, logger);
    expect(lines.find((l) => l['msg'] === 'purge run complete')?.['tables']).toEqual([]);
  });

  it('[NFR-OPS-05] runs at start and again each interval; a failed run is logged and the loop continues', async () => {
    const { logger, lines } = capture();
    let calls = 0;
    const tasks: PurgeTask[] = [
      {
        name: 'audit_entries',
        run: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(1);
        },
      },
    ];
    const loop = startMaintenanceLoop({
      run: () => runPurgeCycle(tasks, db, logger),
      logger,
      intervalMs: 20,
    });
    await expect.poll(() => calls, { timeout: 2_000 }).toBeGreaterThanOrEqual(2);
    await loop.stop();

    expect(lines.some((l) => l['msg'] === 'purge run failed' && l['level'] === 50)).toBe(true);
    expect(lines.some((l) => l['msg'] === 'purge run complete')).toBe(true);

    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(after);
  });

  it("[NFR-OPS-05] a failing task does not stop the tasks after it; the run is logged as failed with the others' counts", async () => {
    const { logger, lines } = capture();
    const tasks: PurgeTask[] = [
      { name: 'audit_entries', run: () => Promise.reject(new Error('permission denied')) },
      { name: 'one_time_tokens', run: () => Promise.resolve(2) },
    ];
    await expect(runPurgeCycle(tasks, db, logger)).resolves.toEqual({
      counts: { one_time_tokens: 2 },
      failed: ['audit_entries'],
    });
    const failed = lines.find((l) => l['msg'] === 'purge run failed');
    expect(failed?.['level']).toBe(50);
    expect(failed?.['failed']).toEqual(['audit_entries']);
    expect(failed?.['tables']).toEqual([{ table: 'one_time_tokens', deleted: 2 }]);
    expect(lines.some((l) => l['msg'] === 'purge run complete')).toBe(false);
  });

  describe('[NFR-OPS-05] long intervals', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('[NFR-OPS-05] waits the full interval even beyond the 24.8-day timer limit', async () => {
      vi.useFakeTimers();
      const { logger } = capture();
      let calls = 0;
      const tasks: PurgeTask[] = [
        { name: 'audit_entries', run: () => Promise.resolve((calls += 1)) },
      ];
      const thirtyDays = 30 * 24 * 60 * 60 * 1_000;

      const loop = startMaintenanceLoop({
        run: () => runPurgeCycle(tasks, db, logger),
        logger,
        intervalMs: thirtyDays,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(thirtyDays - 1_000);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(2);
      await loop.stop();
    });
  });
});

import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { onShutdownSignals } from '../../src/http/shutdown.js';

const silent = pino({ level: 'silent' });

describe('[NFR-OPS-02] shutdown signals', () => {
  it('[NFR-OPS-02] a repeated signal does not kill the process mid-drain; shutdown runs once', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    let runs = 0;
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => (finish = resolve));

    onShutdownSignals(
      () => {
        runs += 1;
        return drained;
      },
      { logger: silent, target, exit: (code) => exits.push(code) },
    );

    target.emit('SIGTERM');
    target.emit('SIGINT');
    target.emit('SIGTERM');
    // Node's default action for a signal with no listener would terminate the process.
    expect(target.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(target.listenerCount('SIGINT')).toBeGreaterThan(0);
    expect(runs).toBe(1);
    expect(exits).toEqual([]);

    finish();
    await expect.poll(() => exits).toEqual([0]);
  });

  it('[NFR-OPS-02] exits 1 when shutdown fails', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    onShutdownSignals(() => Promise.reject(new Error('pool close failed')), {
      logger: silent,
      target,
      exit: (code) => exits.push(code),
    });
    target.emit('SIGTERM');
    await expect.poll(() => exits).toEqual([1]);
  });
});

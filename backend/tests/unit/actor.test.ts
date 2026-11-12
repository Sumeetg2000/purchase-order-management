import { ROLE, SELF_ACTING_ROLE } from '@po/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionRunner } from '../../src/db/transaction.js';
import { createCapture } from '../support/log-capture.js';
import { runAs, userActor } from '../../src/users/actor.js';

const USER = { userId: 'u1', name: 'Bea', email: 'bea@example.local', sessionId: 's1' };

describe('[NFR-AUD-02] user actor context', () => {
  it('[NFR-AUD-02] records the user and the role they act in, and nothing else', () => {
    expect(userActor(USER, ROLE.BUYER)).toEqual({
      type: 'USER',
      userId: 'u1',
      name: 'Bea',
      email: 'bea@example.local',
      actingRole: 'BUYER',
    });
    expect(userActor(USER, SELF_ACTING_ROLE)).toMatchObject({ actingRole: 'SELF' });
  });

  it("[NFR-AUD-02] runAs runs the work once, as that actor, under the request's id and logger", async () => {
    const { logger } = createCapture();
    const run = vi.fn<TransactionRunner['run']>((_context, fn) => fn({} as never, {} as never));
    const result = await runAs({ run }, USER, ROLE.ADMIN, { requestId: 'r1', logger }, () =>
      Promise.resolve(42),
    );
    expect(result).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({
      actor: userActor(USER, ROLE.ADMIN),
      requestId: 'r1',
      logger,
    });
  });
});

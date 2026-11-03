import {
  ACCESS_REQUEST_MESSAGE_MAX_LENGTH,
  OPERATIONS,
  type OperationContract,
} from '@po/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accountsHarness, APP_ORIGIN, cookieHeader } from '../support/accounts.js';

// A no-role user's own access request (ADR-0016 "Access requests"; spec US2 scenarios
// 7–9).

async function noRoleUser(roles = '{}') {
  const h = await accountsHarness();
  const user = await h.seedUser({ roles });
  const jar = await h.loggedIn(user);
  const send = (message: unknown) =>
    request(h.app)
      .post('/me/access-request')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieHeader(jar, 'po_access'))
      .set('X-CSRF-Token', jar['po_csrf'] ?? '')
      .send({ message });
  const read = () => h.get('/me/access-request', jar);
  return { h, user, jar, send, read };
}

describe('[FR-ACC-09] own access request', () => {
  it('[FR-ACC-09] before any request, GET is 404', async () => {
    const { read } = await noRoleUser();
    const res = await read();
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('[FR-ACC-09] the first send opens a request with the trimmed message', async () => {
    const { send, read } = await noRoleUser();
    const res = await send('  Please add me as a buyer  ');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'OPEN',
      message: 'Please add me as a buyer',
      createdAt: expect.any(String) as unknown,
      updatedAt: expect.any(String) as unknown,
      decidedAt: null,
      adminNote: null,
    });
    expect((await read()).body).toEqual(res.body);
  });

  it('[FR-ACC-09] a second send updates the open request: still one row', async () => {
    const { h, send } = await noRoleUser();
    await send('first');
    const res = await send('second');
    expect(res.body).toMatchObject({ status: 'OPEN', message: 'second' });
    expect(await h.query('SELECT message FROM access_requests')).toEqual([{ message: 'second' }]);
  });

  it('[FR-ACC-09] the 4th send in a day is 429', async () => {
    const { send } = await noRoleUser();
    for (const message of ['one', 'two', 'three']) expect((await send(message)).status).toBe(200);
    const res = await send('four');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('[FR-ACC-09] a message is kept as text, HTML and all', async () => {
    const { send } = await noRoleUser();
    expect((await send('<b>hello</b> & <script>x</script>')).body).toMatchObject({
      message: '<b>hello</b> & <script>x</script>',
    });
  });

  it('[FR-ACC-09] an empty or too long message is 400', async () => {
    const { send } = await noRoleUser();
    expect((await send('   ')).status).toBe(400);
    expect((await send('m'.repeat(ACCESS_REQUEST_MESSAGE_MAX_LENGTH + 1))).status).toBe(400);
  });

  it('[FR-ACC-09] after a dismissal, the user sees the note and can open a new request', async () => {
    const { h, send, read } = await noRoleUser();
    await send('first');
    await h.query(
      `UPDATE access_requests SET status = 'DISMISSED', decided_at = now(),
                                  admin_note = 'Ask your manager first'`,
    );
    expect((await read()).body).toMatchObject({
      status: 'DISMISSED',
      adminNote: 'Ask your manager first',
      decidedAt: expect.any(String) as unknown,
    });
    expect((await send('second')).body).toMatchObject({ status: 'OPEN', message: 'second' });
    expect(await h.query('SELECT status FROM access_requests ORDER BY created_at')).toEqual([
      { status: 'DISMISSED' },
      { status: 'OPEN' },
    ]);
  });

  it('[NFR-AUD-04] each send is audited as the user themself, with the request and message', async () => {
    const { h, user, send } = await noRoleUser();
    await send('Please add me');
    const [row] = await h.query<{ id: string }>('SELECT id::text FROM access_requests');
    expect(
      await h.query(
        `SELECT action, actor_user_id::text, acting_role, entity_type, entity_id, details
           FROM audit_entries WHERE action = 'ACCESS_REQUESTED'`,
      ),
    ).toEqual([
      {
        action: 'ACCESS_REQUESTED',
        actor_user_id: user.id,
        acting_role: 'SELF',
        entity_type: 'access_request',
        entity_id: row?.id,
        details: { requestId: row?.id, message: 'Please add me' },
      },
    ]);
  });

  it('[FR-ACC-08] a user with a role gets 403 FORBIDDEN, to read or to send', async () => {
    const { send, read } = await noRoleUser('{BUYER}');
    expect((await read()).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await send('hi')).body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('[FR-ACC-08] what a no-role user may use', () => {
  it('[FR-ACC-08] every role-gated operation answers 403 NO_ROLE_ASSIGNED, before its input', async () => {
    const { h, jar } = await noRoleUser();
    // Admin operations join the contract with US3; the authorization matrix (Polish)
    // covers every cell.
    const operations: readonly OperationContract[] = Object.values(OPERATIONS);
    const gated = operations.filter((op) => op.access === 'admin');
    for (const op of gated) {
      const method = op.method as 'get' | 'post' | 'patch' | 'delete';
      const agent = request(h.app);
      const res = await agent[method](
        op.path.replace(/:\w+/g, '00000000-0000-7000-8000-000000000000'),
      )
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookieHeader(jar, 'po_access'))
        .set('X-CSRF-Token', jar['po_csrf'] ?? '')
        .send({ invalid: true });
      expect(res.body, op.operationId).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
    }
    expect((await h.get('/me', jar)).status).toBe(200);
  });
});

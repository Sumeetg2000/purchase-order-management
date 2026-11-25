import {
  OPERATIONS,
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_APPROVER_READ_ONLY_MESSAGE,
  ORDER_CANCEL_APPROVER_ONLY_MESSAGE,
  ORDER_DECISION_APPROVER_ONLY_MESSAGE,
  PAGE_SIZE_MAX,
  type Access,
  type OperationContract,
} from '@po/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accountsHarness, APP_ORIGIN, cookieHeader, type CookieJar } from '../support/accounts.js';
import { ordersHarness } from '../support/orders.js';
import { vendorBody, vendorsHarness } from '../support/vendors.js';

// The authorization matrix (ADR-0004), generated from the route table: every operation ×
// every caller kind, each cell asserted. Every request carries an unknown query field, so
// a caller the authorize step lets through stops at 400 VALIDATION_FAILED, before any
// handler runs. That proves the cell is open and changes nothing, and a refused cell
// proves the refusal comes before validation (precedence).

/** Each operation's access level, pinned here: changing a cell needs sign-off. */
const PINNED_ACCESS: Record<string, Access> = {
  getHealth: 'public',
  getReadiness: 'public',
  login: 'public',
  signup: 'public',
  verifyEmail: 'public',
  resendVerification: 'public',
  forgotPassword: 'public',
  resetPassword: 'public',
  refreshSession: 'refresh',
  logout: 'refresh',
  logoutAll: 'refresh',
  getMe: 'user',
  updateMe: 'user',
  changePassword: 'user',
  listSessions: 'user',
  revokeSession: 'user',
  getOwnAccessRequest: 'no-role',
  sendAccessRequest: 'no-role',
  listUsers: 'admin',
  getUser: 'admin',
  updateUser: 'admin',
  sendUserPasswordReset: 'admin',
  listAccessRequests: 'admin',
  dismissAccessRequest: 'admin',
  listVendors: 'role',
  getVendor: 'role',
  createVendor: 'role',
  updateVendor: 'role',
  listVendorHistory: 'role',
  deactivateVendor: 'role',
  reactivateVendor: 'role',
  listOrders: 'role',
  listOrderTimeline: 'role',
  getOrder: 'role',
  createOrder: 'role',
  editOrder: 'role',
  deleteOrder: 'role',
  submitOrder: 'role',
  getApprovalPolicy: 'role',
  approveOrder: 'role',
  listApprovalQueue: 'role',
  rejectOrder: 'role',
  cancelOrder: 'role',
  withdrawOrder: 'role',
  // Slice 6: receipts (ADR-0004's receipt row).
  recordReceipt: 'role',
  listOrderReceipts: 'role',
  getOrderReceipt: 'role',
};

/** The roles of each role-level operation (ADR-0004's vendor rows), pinned the same way. */
const PINNED_ROLES: Record<string, readonly string[]> = {
  listVendors: ['BUYER', 'APPROVER', 'ADMIN'],
  getVendor: ['BUYER', 'APPROVER', 'ADMIN'],
  createVendor: ['BUYER'],
  updateVendor: ['BUYER'],
  listVendorHistory: ['BUYER', 'ADMIN'],
  deactivateVendor: ['BUYER'],
  reactivateVendor: ['BUYER'],
  listOrders: ['BUYER', 'APPROVER', 'ADMIN'],
  listOrderTimeline: ['BUYER', 'APPROVER', 'ADMIN'],
  getOrder: ['BUYER', 'APPROVER', 'ADMIN'],
  createOrder: ['BUYER'],
  editOrder: ['BUYER'],
  deleteOrder: ['BUYER'],
  submitOrder: ['BUYER'],
  getApprovalPolicy: ['BUYER', 'APPROVER', 'ADMIN'],
  approveOrder: ['APPROVER'],
  listApprovalQueue: ['APPROVER'],
  rejectOrder: ['APPROVER'],
  cancelOrder: ['APPROVER'],
  withdrawOrder: ['BUYER'],
  recordReceipt: ['BUYER'],
  listOrderReceipts: ['BUYER', 'APPROVER', 'ADMIN'],
  getOrderReceipt: ['BUYER', 'APPROVER', 'ADMIN'],
};

/** Callable with no session (ADR-0004 "Public endpoints", plus the slice 0 health checks). */
const PUBLIC_OPERATIONS = [
  'forgotPassword',
  'getHealth',
  'getReadiness',
  'login',
  'resendVerification',
  'resetPassword',
  'signup',
  'verifyEmail',
];

const CALLERS = {
  anonymous: null,
  'no role': '{}',
  Buyer: '{BUYER}',
  Approver: '{APPROVER}',
  'Buyer+Approver': '{BUYER,APPROVER}',
  Admin: '{ADMIN}',
} as const;
type Caller = keyof typeof CALLERS;

/** The single role of a caller refused at route level, keying forbiddenDetail. */
const ROLE_OF: Partial<Record<Caller, 'BUYER' | 'APPROVER' | 'ADMIN'>> = {
  Buyer: 'BUYER',
  Approver: 'APPROVER',
  Admin: 'ADMIN',
};

type Outcome = 'OPEN' | 'UNAUTHENTICATED' | 'NO_ROLE_ASSIGNED' | 'FORBIDDEN';

/** The cell's expected outcome, from ADR-0004's matrix. */
function expected({ access, roles }: OperationContract, caller: Caller): Outcome {
  if (access === 'public') return 'OPEN';
  if (caller === 'anonymous') return 'UNAUTHENTICATED';
  switch (access) {
    case 'refresh':
    case 'user':
      return 'OPEN';
    case 'no-role':
      return caller === 'no role' ? 'OPEN' : 'FORBIDDEN';
    case 'admin':
      if (caller === 'no role') return 'NO_ROLE_ASSIGNED';
      return caller === 'Admin' ? 'OPEN' : 'FORBIDDEN';
    case 'role': {
      if (caller === 'no role') return 'NO_ROLE_ASSIGNED';
      const held = CALLERS[caller].replace(/[{}]/g, '').split(',');
      return held.some((role) => roles?.includes(role as never)) ? 'OPEN' : 'FORBIDDEN';
    }
  }
}

const STATUS: Record<Outcome, number> = {
  OPEN: 400,
  UNAUTHENTICATED: 401,
  NO_ROLE_ASSIGNED: 403,
  FORBIDDEN: 403,
};

const ANY_ID = '00000000-0000-7000-8000-000000000000';
const operations: readonly OperationContract[] = Object.values(OPERATIONS);

describe('[NFR-AUTH-02] the route table is the pinned matrix', () => {
  it('[NFR-AUTH-02] every operation has a pinned access level, and it matches the contract', () => {
    const served = Object.fromEntries(operations.map((op) => [op.operationId, op.access]));
    expect(served).toEqual(PINNED_ACCESS);
  });

  it('[NFR-AUTH-02] every role-level operation has its pinned roles', () => {
    const served = Object.fromEntries(
      operations.filter((op) => op.roles).map((op) => [op.operationId, op.roles]),
    );
    expect(served).toEqual(PINNED_ROLES);
  });

  it('[NFR-AUTH-02] the public operations are exactly the pinned list', () => {
    const open = operations.filter((op) => op.access === 'public').map((op) => op.operationId);
    expect(open.sort()).toEqual(PUBLIC_OPERATIONS);
  });
});

describe('[SC-005] authorization matrix: every operation × every caller kind', () => {
  it('[NFR-AUTH-02] each cell is open or refused exactly as the matrix says', async () => {
    const h = await accountsHarness();
    const jars = new Map<Caller, CookieJar | null>();
    for (const [caller, roles] of Object.entries(CALLERS) as [Caller, string | null][]) {
      jars.set(caller, roles === null ? null : await h.loggedIn(await h.seedUser({ roles })));
    }

    const cells: string[] = [];
    for (const op of operations) {
      const path = `${op.path.replace(/:\w+/g, ANY_ID)}?matrixProbe=1`;
      for (const caller of Object.keys(CALLERS) as Caller[]) {
        const jar = jars.get(caller) ?? null;
        const agent = request(h.app);
        let req = agent[op.method](path).set('Origin', APP_ORIGIN);
        if (jar) {
          req = req
            .set('Cookie', cookieHeader(jar, 'po_access', 'po_refresh'))
            .set('X-CSRF-Token', jar['po_csrf'] ?? '');
        }
        const res = await req;
        const outcome = expected(op, caller);
        const cell = `${op.operationId} × ${caller}`;
        cells.push(cell);
        expect(res.status, cell).toBe(STATUS[outcome]);
        if (outcome === 'OPEN') {
          expect(res.body, cell).toMatchObject({
            code: 'VALIDATION_FAILED',
            details: expect.arrayContaining([
              { path: 'query.matrixProbe', code: 'UNKNOWN_FIELD' },
            ]) as unknown,
          });
        } else {
          expect(res.body, cell).toMatchObject({ code: outcome });
          // A route-level FORBIDDEN on an order action says why, by the caller's one role
          // (ADR-0004, 2026-11-12 and 2026-11-17).
          const roleDetail =
            outcome === 'FORBIDDEN' && ROLE_OF[caller] !== undefined
              ? op.forbiddenDetail?.[ROLE_OF[caller]]
              : undefined;
          if (roleDetail !== undefined) {
            expect(res.body, cell).toMatchObject({ detail: roleDetail });
          } else {
            expect((res.body as { detail?: unknown }).detail, cell).toBeUndefined();
          }
        }
      }
    }
    // Zero cells untested: 47 operations (2 health checks, 22 of slice 1, 7 vendor ones,
    // 6 order ones, 6 of slice 4, cancel of slice 5, 3 receipt ones of slice 6) × 6 callers.
    expect(cells).toHaveLength(operations.length * Object.keys(CALLERS).length);
    expect(operations).toHaveLength(47);
  });
});

describe('[FR-ACT-01] the vendor rows (ADR-0004)', () => {
  /** Every vendor write, each with a body or headers that would fail validation. */
  const WRITES = [
    { op: 'createVendor', method: 'post', path: () => '/vendors', body: { bogus: 1 } },
    { op: 'updateVendor', method: 'put', path: (id: string) => `/vendors/${id}`, body: {} },
    {
      op: 'deactivateVendor',
      method: 'post',
      path: (id: string) => `/vendors/${id}/deactivate`,
      body: { bogus: 1 },
    },
    {
      op: 'reactivateVendor',
      method: 'post',
      path: (id: string) => `/vendors/${id}/reactivate`,
      body: { bogus: 1 },
    },
  ] as const;

  it('[FR-ACT-01] Approver and Admin writes are 403 FORBIDDEN before the body is validated, changing nothing', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    for (const roles of ['{APPROVER}', '{ADMIN}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      for (const write of WRITES) {
        // No If-Match either: the role refusal comes before every 400.
        const res = await h.send(write.method, write.path(id), jar, write.body);
        expect(res.status, `${write.op} as ${roles}`).toBe(403);
        expect(res.body, `${write.op} as ${roles}`).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(await h.query('SELECT version FROM vendors')).toEqual([{ version: 1 }]);
    expect(await h.vendorAudit()).toEqual([]);
  });

  it('[FR-ACT-01] a user with no role is 403 NO_ROLE_ASSIGNED and an anonymous caller 401 on vendor reads', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const noRole = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    for (const path of ['/vendors', `/vendors/${id}`]) {
      const refused = await h.get(path, noRole);
      expect(refused.status, path).toBe(403);
      expect(refused.body, path).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
      const anonymous = await request(h.app).get(path).set('Origin', APP_ORIGIN);
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.body, path).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('[FR-ACT-01] vendors have no owner: another Buyer edits, deactivates and reactivates one', async () => {
    const h = await vendorsHarness();
    const created = await h.createVendor(vendorBody());
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));

    expect(
      (await h.updateVendor(id, vendorBody({ name: 'Acme Industrial' }), 1, other)).status,
    ).toBe(200);
    expect((await h.setStatus(id, 'deactivate', 2, other)).status).toBe(200);
    expect((await h.setStatus(id, 'reactivate', 3, other)).status).toBe(200);
    expect((await h.vendorAudit()).map((entry) => entry.action)).toEqual([
      'VENDOR_CREATED',
      'VENDOR_UPDATED',
      'VENDOR_DEACTIVATED',
      'VENDOR_REACTIVATED',
    ]);
  });
});

describe('[FR-OWN-01] the draft order rows (ADR-0004)', () => {
  it('[FR-OWN-01] a draft is read by its owner and an Admin; another Buyer, an Approver and a Buyer+Approver get 404', async () => {
    const h = await ordersHarness();
    const created = await h.createOrder(h.orderBody());
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const readers: [string, number][] = [
      ['{BUYER}', 404],
      ['{APPROVER}', 404],
      ['{BUYER,APPROVER}', 404],
      ['{ADMIN}', 200],
    ];
    expect((await h.getOrder(id)).status).toBe(200);
    for (const [roles, status] of readers) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.getOrder(id, jar);
      expect(res.status, roles).toBe(status);
      if (status === 404) expect(res.body, roles).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('[FR-ACT-01] an Approver or an Admin editing a draft is 403 before validation, each told why', async () => {
    const h = await ordersHarness();
    const id = ((await h.createOrder(h.orderBody())).body as { id: string }).id;
    for (const [roles, detail] of [
      // ADR-0004, 2026-11-17: a pure Approver is told why too.
      ['{APPROVER}', ORDER_APPROVER_READ_ONLY_MESSAGE],
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.editOrder(id, { bogus: 1 }, null, jar);
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN' });
      expect((res.body as { detail?: string }).detail, roles).toBe(detail);
    }
    expect(((await h.getOrder(id)).body as { version: number }).version).toBe(1);
  });

  it('[FR-ACT-01] an Approver or an Admin creating an order is 403 before validation, each told why', async () => {
    const h = await ordersHarness();
    for (const [roles, detail] of [
      // ADR-0004, 2026-11-17: a pure Approver is told why too.
      ['{APPROVER}', ORDER_APPROVER_READ_ONLY_MESSAGE],
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.createOrder({ bogus: 1 }, { as: jar, key: null });
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN' });
      expect((res.body as { detail?: string }).detail, roles).toBe(detail);
    }
    expect(await h.count('purchase_orders')).toBe(0);
  });
});

// The order rows (ADR-0004, 2026-11-17 S1–S7): every order state × every caller kind,
// relative to the order, × every order action. Each write is sent valid but with a stale
// If-Match, so a cell the caller may use stops at 409 and nothing changes; a refused cell
// shows its exact code, and its role detail where ADR-0004 gives one.

const ORDER_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
type OrderState = (typeof ORDER_STATES)[number];

const ORDER_CALLERS = [
  'owner Buyer',
  'owner Buyer+Approver',
  'other Buyer',
  'Approver',
  'other Buyer+Approver',
  'Admin',
  'no role',
  'anonymous',
] as const;
type OrderCaller = (typeof ORDER_CALLERS)[number];

type Cell =
  | { code: 'OK' }
  | { code: 'UNAUTHENTICATED' | 'NO_ROLE_ASSIGNED' | 'NOT_FOUND' }
  | { code: 'NOT_ORDER_OWNER' | 'SELF_APPROVAL' }
  | { code: 'FORBIDDEN'; detail: string };

const OK: Cell = { code: 'OK' };
const forbidden = (detail: string): Cell => ({ code: 'FORBIDDEN', detail });

function owns(caller: OrderCaller) {
  return caller === 'owner Buyer' || caller === 'owner Buyer+Approver';
}

/** ADR-0004's "Read DRAFT order" and "Read non-draft order" rows. */
function canRead(caller: OrderCaller, state: OrderState) {
  if (owns(caller) || caller === 'Admin') return true;
  if (caller === 'Approver' || caller === 'other Buyer+Approver') return state !== 'DRAFT';
  return false;
}

/** Refusals before any order is looked at: 401, then the role checks. */
function gate(caller: OrderCaller): Cell | null {
  if (caller === 'anonymous') return { code: 'UNAUTHENTICATED' };
  if (caller === 'no role') return { code: 'NO_ROLE_ASSIGNED' };
  return null;
}

/** Edit, delete, submit, withdraw: the row "Edit, submit, withdraw, delete" with S2, S4. */
function ownerWrite(caller: OrderCaller, state: OrderState): Cell {
  const refused = gate(caller);
  if (refused) return refused;
  if (caller === 'Admin') return forbidden(ORDER_ADMIN_READ_ONLY_MESSAGE);
  if (caller === 'Approver') return forbidden(ORDER_APPROVER_READ_ONLY_MESSAGE);
  if (!canRead(caller, state)) return { code: 'NOT_FOUND' };
  if (!owns(caller)) return { code: 'NOT_ORDER_OWNER' };
  return OK;
}

/** Approve, reject: the row "Approve or reject" with S3, S4 and separation of duties. */
function decision(caller: OrderCaller, state: OrderState): Cell {
  const refused = gate(caller);
  if (refused) return refused;
  if (caller === 'Admin') return forbidden(ORDER_ADMIN_READ_ONLY_MESSAGE);
  if (caller === 'owner Buyer' || caller === 'other Buyer') {
    return forbidden(ORDER_DECISION_APPROVER_ONLY_MESSAGE);
  }
  if (!canRead(caller, state)) return { code: 'NOT_FOUND' };
  if (owns(caller)) return { code: 'SELF_APPROVAL' };
  return OK;
}

/** Cancel: the row "Cancel approved order" (amended 2026-11-20): a pure Buyer is refused at
 * route level, owner or not; an Approver's own order is SELF_APPROVAL. */
function cancel(caller: OrderCaller, state: OrderState): Cell {
  const refused = gate(caller);
  if (refused) return refused;
  if (caller === 'Admin') return forbidden(ORDER_ADMIN_READ_ONLY_MESSAGE);
  if (caller === 'owner Buyer' || caller === 'other Buyer') {
    return forbidden(ORDER_CANCEL_APPROVER_ONLY_MESSAGE);
  }
  if (!canRead(caller, state)) return { code: 'NOT_FOUND' };
  if (owns(caller)) return { code: 'SELF_APPROVAL' };
  return OK;
}

function read(caller: OrderCaller, state: OrderState): Cell {
  return gate(caller) ?? (canRead(caller, state) ? OK : { code: 'NOT_FOUND' });
}

/** The approval queue and its count (S1): Approvers only, others' pending orders only. */
function queue(caller: OrderCaller): Cell | { code: 'FORBIDDEN' } {
  const refused = gate(caller);
  if (refused) return refused;
  if (caller === 'Approver' || caller.endsWith('Buyer+Approver')) return OK;
  return { code: 'FORBIDDEN' };
}

describe('[FR-OWN-01] the order rows: every state × every caller × every action (ADR-0004)', () => {
  it('[NFR-AUTH-02] each cell has the exact code, the role detail, and nothing changes', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const dual = await h.approver('{BUYER,APPROVER}', 'Dev Dual');
    const jars: Record<OrderCaller, CookieJar | null> = {
      'owner Buyer': h.jar,
      'owner Buyer+Approver': dual.jar,
      'other Buyer': await h.loggedIn(await h.seedUser({ roles: '{BUYER}' })),
      Approver: priya.jar,
      'other Buyer+Approver': (await h.approver('{BUYER,APPROVER}', 'Oli Other')).jar,
      Admin: await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' })),
      'no role': await h.loggedIn(await h.seedUser({ roles: '{}' })),
      anonymous: null,
    };

    /** One order in each state, owned through `jar`. */
    async function ordersOf(jar: CookieJar): Promise<Record<OrderState, string>> {
      const draft = (await h.draftAt('200000', jar)).id;
      const pending = (await h.draftAt('200000', jar)).id;
      await h.submitOrder(pending, 1, jar);
      const approved = (await h.draftAt('10', jar)).id;
      await h.submitOrder(approved, 1, jar);
      const rejected = (await h.draftAt('200000', jar)).id;
      await h.submitOrder(rejected, 1, jar);
      await h.rejectOrder(rejected, 2, priya.jar, { reason: 'Vendor quote expired' });
      const cancelled = (await h.draftAt('10', jar)).id;
      await h.submitOrder(cancelled, 1, jar);
      await h.cancelOrder(cancelled, 2, priya.jar, { reason: 'Supplier closed' });
      return {
        DRAFT: draft,
        PENDING_APPROVAL: pending,
        APPROVED: approved,
        REJECTED: rejected,
        CANCELLED: cancelled,
      };
    }
    const buyerOrders = await ordersOf(h.jar);
    const dualOrders = await ordersOf(dual.jar);
    const statuses = await h.query<{ id: string; status: string; version: number }>(
      `SELECT id::text, status, version FROM purchase_orders ORDER BY id`,
    );
    for (const state of ORDER_STATES) {
      expect(statuses.find((o) => o.id === buyerOrders[state])?.status).toBe(state);
      expect(statuses.find((o) => o.id === dualOrders[state])?.status).toBe(state);
    }

    function send(
      caller: OrderCaller,
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
      body?: unknown,
    ) {
      const jar = jars[caller];
      const stale = method === 'get' ? {} : { 'If-Match': '"999"' };
      if (jar) return method === 'get' ? h.get(path, jar) : h.send(method, path, jar, body, stale);
      const anonymous = request(h.app);
      return anonymous[method](path)
        .set('Origin', APP_ORIGIN)
        .set(stale)
        .send(body as object);
    }

    const reason = { reason: 'Matrix probe reason' };
    const ACTIONS = {
      read: { rule: read, call: (c: OrderCaller, id: string) => send(c, 'get', `/orders/${id}`) },
      timeline: {
        rule: read,
        call: (c: OrderCaller, id: string) => send(c, 'get', `/orders/${id}/timeline`),
      },
      edit: {
        rule: ownerWrite,
        call: (c: OrderCaller, id: string) => send(c, 'patch', `/orders/${id}`, h.orderBody()),
      },
      delete: {
        rule: ownerWrite,
        call: (c: OrderCaller, id: string) => send(c, 'delete', `/orders/${id}`),
      },
      submit: {
        rule: ownerWrite,
        call: (c: OrderCaller, id: string) => send(c, 'post', `/orders/${id}/submit`),
      },
      withdraw: {
        rule: ownerWrite,
        call: (c: OrderCaller, id: string) => send(c, 'post', `/orders/${id}/withdraw`, reason),
      },
      approve: {
        rule: decision,
        call: (c: OrderCaller, id: string) => send(c, 'post', `/orders/${id}/approve`),
      },
      reject: {
        rule: decision,
        call: (c: OrderCaller, id: string) => send(c, 'post', `/orders/${id}/reject`, reason),
      },
      cancel: {
        rule: cancel,
        call: (c: OrderCaller, id: string) => send(c, 'post', `/orders/${id}/cancel`, reason),
      },
    } as const;

    const cells: string[] = [];
    for (const caller of ORDER_CALLERS) {
      const orders = caller === 'owner Buyer+Approver' ? dualOrders : buyerOrders;
      for (const state of ORDER_STATES) {
        for (const [action, { rule, call }] of Object.entries(ACTIONS)) {
          const cell = `${action} ${state} × ${caller}`;
          cells.push(cell);
          const want = rule(caller, state);
          const res = await call(caller, orders[state]);
          const body = res.body as { code?: string; detail?: string };
          if (want.code === 'OK') {
            // Reads succeed; a write the caller may make stops at a 409 (state or version).
            expect(res.status, cell).toBe(action === 'read' || action === 'timeline' ? 200 : 409);
          } else {
            expect(body.code, cell).toBe(want.code);
            if ('detail' in want) expect(body.detail, cell).toBe(want.detail);
          }
        }

        // The order lists: an order is listed exactly when the caller can read it.
        const list = `list ${state} × ${caller}`;
        cells.push(list);
        const listed = await send(caller, 'get', `/orders?pageSize=${String(PAGE_SIZE_MAX)}`);
        const listRefused = gate(caller);
        if (listRefused) {
          expect((listed.body as { code?: string }).code, list).toBe(listRefused.code);
        } else {
          const ids = (listed.body as { items: { id: string }[] }).items.map((i) => i.id);
          expect(ids.includes(orders[state]), list).toBe(canRead(caller, state));
        }

        // The queue and its count (S1): only others' pending orders.
        for (const [kind, query] of [
          ['queue', `?pageSize=${String(PAGE_SIZE_MAX)}`],
          ['count', '?pageSize=1'],
        ] as const) {
          const qcell = `${kind} ${state} × ${caller}`;
          cells.push(qcell);
          const res = await send(caller, 'get', `/approvals${query}`);
          const want = queue(caller);
          if (want.code !== 'OK') {
            expect((res.body as { code?: string }).code, qcell).toBe(want.code);
            continue;
          }
          const page = res.body as { items: { id: string }[]; total: number };
          const visible = state === 'PENDING_APPROVAL' && !owns(caller);
          if (kind === 'queue') {
            expect(
              page.items.some((i) => i.id === orders[state]),
              qcell,
            ).toBe(visible);
          } else {
            // Of the two pending orders, the caller's count holds those they don't own.
            const expectedCount = caller === 'owner Buyer+Approver' ? 1 : 2;
            expect(page.total, qcell).toBe(expectedCount);
          }
        }

        // The approval policy: every role reads it.
        const pcell = `policy × ${caller}`;
        cells.push(pcell);
        const policy = await send(caller, 'get', '/approval-policy');
        const pwant = gate(caller) ?? OK;
        if (pwant.code === 'OK') expect(policy.status, pcell).toBe(200);
        else expect((policy.body as { code?: string }).code, pcell).toBe(pwant.code);
      }
    }

    // 8 callers × 5 states × (9 actions + list + queue + count + policy).
    expect(cells).toHaveLength(8 * 5 * 13);
    // Nothing changed: every order kept its status and version.
    expect(
      await h.query(`SELECT id::text, status, version FROM purchase_orders ORDER BY id`),
    ).toEqual(statuses);
  });
});

import { describe, expect, it } from 'vitest';
import { vendorsHarness, type VendorsHarness } from '../support/vendors.js';

// Listing and reading vendors (spec US1, FR-009; research R2): active by default, the
// status filter, a case- and space-insensitive name prefix taken literally, sorted by the
// name key then id, and the page envelope. Every role reads.

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

interface Listed {
  items: { id: string; name: string; status: string }[];
  page: number;
  pageSize: number;
  total: number;
}

const names = (body: unknown) => (body as Listed).items.map((v) => v.name);

async function seeded() {
  const h = await vendorsHarness();
  await h.seedVendor({ name: 'beta Traders' });
  await h.seedVendor({ name: 'Acme Supplies' });
  await h.seedVendor({ name: 'acme tools' });
  await h.seedVendor({ name: 'Acorn Ltd', status: 'INACTIVE' });
  await h.seedVendor({ name: '100% Steel' });
  await h.seedVendor({ name: '1000 Bolts' });
  await h.seedVendor({ name: 'A_B Traders' });
  await h.seedVendor({ name: 'ABC Metals' });
  return h;
}

function list(h: VendorsHarness, query = '') {
  return h.get(`/vendors${query}`, h.jar);
}

describe('[FR-VEN-01] vendor list', () => {
  it('[FR-VEN-01] lists active vendors by default, sorted by the name key, in the page envelope', async () => {
    const h = await seeded();
    const res = await list(h);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 7 });
    // name_key is COLLATE "C": '%' sorts before '0', digits before letters.
    expect(names(res.body)).toEqual([
      '100% Steel',
      '1000 Bolts',
      'A_B Traders',
      'ABC Metals',
      'Acme Supplies',
      'acme tools',
      'beta Traders',
    ]);
    expect((res.body as Listed).items.every((v) => v.status === 'ACTIVE')).toBe(true);
  });

  it('[FR-VEN-01] returns each vendor in full', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies', contactPhone: '022 4000 1000' });
    const res = await list(h);
    expect((res.body as Listed).items).toEqual([
      {
        id,
        name: 'Acme Supplies',
        contactName: 'Ravi Shah',
        contactEmail: 'ravi@acme.example',
        contactPhone: '022 4000 1000',
        paymentTerms: { type: 'NET', netDays: 30 },
        status: 'ACTIVE',
        deactivatedAt: null,
        version: 1,
      },
    ]);
  });

  it('[FR-VEN-01] filters by INACTIVE and ALL', async () => {
    const h = await seeded();
    const inactive = await list(h, '?status=INACTIVE');
    expect(names(inactive.body)).toEqual(['Acorn Ltd']);
    expect(inactive.body).toMatchObject({ total: 1 });
    expect((inactive.body as Listed).items[0]).toMatchObject({
      status: 'INACTIVE',
      deactivatedAt: expect.any(String) as unknown,
    });
    const all = await list(h, '?status=ALL');
    expect(all.body).toMatchObject({ total: 8 });
    expect(names(all.body)).toContain('Acorn Ltd');
  });

  it('[FR-VEN-01] a status filter in lower case is 400', async () => {
    const h = await seeded();
    const res = await list(h, '?status=active');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'query.status', code: 'INVALID_FORMAT' }],
    });
  });

  it('[FR-VEN-01] the name prefix ignores case and spacing', async () => {
    const h = await seeded();
    const res = await list(h, `?q=${encodeURIComponent('  ACME   s')}`);
    expect(names(res.body)).toEqual(['Acme Supplies']);
    expect(res.body).toMatchObject({ total: 1 });
    expect(names((await list(h, '?q=acm')).body)).toEqual(['Acme Supplies', 'acme tools']);
    // The prefix applies within the status filter.
    expect(names((await list(h, '?q=ac&status=ALL')).body)).toEqual([
      'Acme Supplies',
      'acme tools',
      'Acorn Ltd',
    ]);
  });

  it('[FR-VEN-01] % and _ in the prefix are taken literally', async () => {
    const h = await seeded();
    expect(names((await list(h, `?q=${encodeURIComponent('100%')}`)).body)).toEqual(['100% Steel']);
    expect(names((await list(h, '?q=a_')).body)).toEqual(['A_B Traders']);
    expect(names((await list(h, `?q=${encodeURIComponent('\\')}`)).body)).toEqual([]);
  });

  it('[FR-VEN-01] pages through the list, and a page past the end is empty', async () => {
    const h = await seeded();
    const second = await list(h, '?pageSize=2&page=2');
    expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 7 });
    expect(names(second.body)).toEqual(['A_B Traders', 'ABC Metals']);
    const past = await list(h, '?pageSize=2&page=9');
    expect(past.status).toBe(200);
    expect(past.body).toEqual({ items: [], page: 9, pageSize: 2, total: 7 });
  });

  it('[FR-VEN-01] Approvers and Admins list vendors too', async () => {
    const h = await seeded();
    for (const roles of ['{APPROVER}', '{ADMIN}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.get('/vendors', jar);
      expect(res.status, roles).toBe(200);
      expect(res.body, roles).toMatchObject({ total: 7 });
    }
  });
});

describe('[FR-VEN-01] read one vendor', () => {
  it('[FR-VEN-01] returns the vendor with its version as ETag, to every role', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const res = await h.get(`/vendors/${id}`, h.jar);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'Acme Supplies', version: 1 });
    expect(res.get('ETag')).toBe('"1"');
    const approver = await h.loggedIn(await h.seedUser({ roles: '{APPROVER}' }));
    expect((await h.get(`/vendors/${id}`, approver)).status).toBe(200);
  });

  it('[FR-VEN-01] an inactive vendor is still readable', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Old Acme', status: 'INACTIVE' });
    const res = await h.get(`/vendors/${id}`, h.jar);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'INACTIVE' });
  });

  it('[FR-VEN-01] an unknown id is 404 and a malformed one 400', async () => {
    const h = await vendorsHarness();
    const missing = await h.get(`/vendors/${UNKNOWN_ID}`, h.jar);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    const malformed = await h.get('/vendors/not-a-uuid', h.jar);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'path.id', code: 'INVALID_FORMAT' }],
    });
  });
});

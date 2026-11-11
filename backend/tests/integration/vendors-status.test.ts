import { describe, expect, it } from 'vitest';
import { vendorsHarness, type VendorsHarness } from '../support/vendors.js';

// Deactivating and reactivating a vendor (spec US3; FR-005, FR-007; research R8): separate
// actions under If-Match, each valid only from the opposite state, one audit entry each.
// Vendors are never deleted.

async function stored(h: VendorsHarness, id: string) {
  const [row] = await h.query<{
    status: string;
    deactivated_at: Date | null;
    version: number;
  }>('SELECT status, deactivated_at, version FROM vendors WHERE id = $1', [id]);
  return row;
}

const SNAPSHOT = {
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
};

describe('[FR-VEN-01] deactivate and reactivate a vendor', () => {
  it('[FR-VEN-01] deactivate with the current If-Match is 200: INACTIVE, deactivatedAt set, version +1, one entry', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });

    const res = await h.setStatus(id, 'deactivate', 1);
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"2"');
    expect(res.body).toMatchObject({ id, status: 'INACTIVE', version: 2 });
    expect(typeof (res.body as { deactivatedAt: unknown }).deactivatedAt).toBe('string');
    const row = await stored(h, id);
    expect(row?.status).toBe('INACTIVE');
    expect(row?.deactivated_at).toBeInstanceOf(Date);

    expect(await h.vendorAudit()).toEqual([
      {
        action: 'VENDOR_DEACTIVATED',
        entity_type: 'vendor',
        entity_id: id,
        actor_user_id: h.buyer.id,
        acting_role: 'BUYER',
        details: {
          before: { ...SNAPSHOT, status: 'ACTIVE' },
          after: { ...SNAPSHOT, status: 'INACTIVE' },
        },
      },
    ]);
  });

  it('[FR-VEN-01] a deactivated vendor leaves the default list but stays under INACTIVE, ALL and by id', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    expect((await h.setStatus(id, 'deactivate', 1)).status).toBe(200);

    const ids = async (query: string) =>
      ((await h.get(`/vendors${query}`, h.jar)).body as { items: { id: string }[] }).items.map(
        (vendor) => vendor.id,
      );
    expect(await ids('')).toEqual([]);
    expect(await ids('?status=INACTIVE')).toEqual([id]);
    expect(await ids('?status=ALL')).toEqual([id]);
    expect((await h.get(`/vendors/${id}`, h.jar)).body).toMatchObject({ status: 'INACTIVE' });
  });

  it('[FR-VEN-01] reactivate with the current If-Match is 200: ACTIVE, deactivatedAt cleared, version +1, one entry', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies', status: 'INACTIVE' });

    const res = await h.setStatus(id, 'reactivate', 1);
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"2"');
    expect(res.body).toMatchObject({ id, status: 'ACTIVE', deactivatedAt: null, version: 2 });
    expect(await stored(h, id)).toEqual({ status: 'ACTIVE', deactivated_at: null, version: 2 });

    const entries = await h.vendorAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'VENDOR_REACTIVATED',
      entity_id: id,
      details: {
        before: { ...SNAPSHOT, status: 'INACTIVE' },
        after: { ...SNAPSHOT, status: 'ACTIVE' },
      },
    });
  });

  it('[FR-VEN-01] a repeat is 409 INVALID_STATE_TRANSITION with no entry and the version unchanged', async () => {
    const h = await vendorsHarness();
    const active = await h.seedVendor({ name: 'Acme Supplies' });
    const inactive = await h.seedVendor({ name: 'Beta Traders', status: 'INACTIVE' });

    const reactivate = await h.setStatus(active, 'reactivate', 1);
    expect(reactivate.status).toBe(409);
    expect(reactivate.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    const deactivate = await h.setStatus(inactive, 'deactivate', 1);
    expect(deactivate.status).toBe(409);
    expect(deactivate.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    expect((await stored(h, active))?.version).toBe(1);
    expect((await stored(h, inactive))?.version).toBe(1);
    expect(await h.vendorAudit()).toEqual([]);
  });

  it('[FR-VEN-01] a stale If-Match is 409 VERSION_CONFLICT, checked before the state', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    expect((await h.setStatus(id, 'deactivate', 1)).status).toBe(200);

    // Stale and also the wrong state: the version is checked first.
    const stale = await h.setStatus(id, 'deactivate', 1);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await stored(h, id))?.version).toBe(2);
    expect(await h.vendorAudit()).toHaveLength(1);
  });

  it('[FR-VEN-01] a missing If-Match is 400 VERSION_REQUIRED; an unknown id is 404', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    for (const action of ['deactivate', 'reactivate'] as const) {
      const missing = await h.setStatus(id, action, null);
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
      });
      const unknown = await h.setStatus('00000000-0000-4000-8000-000000000000', action, 1);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await stored(h, id))?.version).toBe(1);
  });

  it('[FR-VEN-01] a body is refused: the status actions take none', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const res = await h.send(
      'post',
      `/vendors/${id}/deactivate`,
      h.jar,
      { status: 'INACTIVE' },
      {
        'If-Match': '"1"',
      },
    );
    expect(res.status).toBe(400);
    expect((await stored(h, id))?.version).toBe(1);
  });

  it('[FR-VEN-01] there is no delete route, and po_app cannot delete a vendor row', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });

    const res = await h.send('delete', `/vendors/${id}`, h.jar);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });

    const app = await h.db.client('po_app');
    await expect(app.query('DELETE FROM vendors WHERE id = $1', [id])).rejects.toMatchObject({
      code: '42501',
    });
    expect(await stored(h, id)).toMatchObject({ status: 'ACTIVE', version: 1 });
  });
});

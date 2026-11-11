import { describe, expect, it } from 'vitest';
import { vendorBody, vendorsHarness, type VendorsHarness } from '../support/vendors.js';

// Editing a vendor (spec US2; FR-006; research R6, R7, R8): a full replacement under
// If-Match, one VENDOR_UPDATED entry per accepted edit, and the name rule on rename.

async function created(h: VendorsHarness, extra: Record<string, unknown> = {}) {
  const res = await h.createVendor(vendorBody(extra));
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function stored(h: VendorsHarness, id: string) {
  const [row] = await h.query<{ name: string; contact_phone: string | null; version: number }>(
    'SELECT name, contact_phone, version FROM vendors WHERE id = $1',
    [id],
  );
  return row;
}

describe('[FR-VEN-01] edit a vendor', () => {
  it('[FR-VEN-01] a PUT with the current If-Match is 200, moves the version and audits before → after', async () => {
    const h = await vendorsHarness();
    const id = await created(h, { contactPhone: '022 4000 1000' });
    const res = await h.updateVendor(
      id,
      vendorBody({
        name: 'Acme Industrial',
        contactName: 'Meera Iyer',
        contactEmail: 'Meera@ACME.example',
        contactPhone: '022 4000 2000',
        paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 60 },
      }),
      1,
    );
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"2"');
    expect(res.body).toMatchObject({
      id,
      name: 'Acme Industrial',
      contactName: 'Meera Iyer',
      contactEmail: 'meera@acme.example',
      contactPhone: '022 4000 2000',
      paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 60 },
      status: 'ACTIVE',
      version: 2,
    });

    const [, updated] = await h.vendorAudit();
    expect(updated).toEqual({
      action: 'VENDOR_UPDATED',
      entity_type: 'vendor',
      entity_id: id,
      actor_user_id: h.buyer.id,
      acting_role: 'BUYER',
      details: {
        before: {
          name: 'Acme Supplies',
          contactName: 'Ravi Shah',
          contactEmail: 'ravi@acme.example',
          contactPhone: '022 4000 1000',
          paymentTerms: { type: 'NET', netDays: 30 },
          status: 'ACTIVE',
        },
        after: {
          name: 'Acme Industrial',
          contactName: 'Meera Iyer',
          contactEmail: 'meera@acme.example',
          contactPhone: '022 4000 2000',
          paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 60 },
          status: 'ACTIVE',
        },
      },
    });
  });

  it('[FR-VEN-01] a save with no change still writes one entry and moves the version', async () => {
    const h = await vendorsHarness();
    const id = await created(h);
    const res = await h.updateVendor(id, vendorBody(), 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2 });
    expect((await h.vendorAudit()).map((entry) => entry.action)).toEqual([
      'VENDOR_CREATED',
      'VENDOR_UPDATED',
    ]);
  });

  it('[FR-VEN-01] a missing If-Match is 400 VERSION_REQUIRED; a stale one 409 with nothing changed', async () => {
    const h = await vendorsHarness();
    const id = await created(h);
    const missing = await h.updateVendor(id, vendorBody({ name: 'Renamed' }), null);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
    });
    expect((await h.updateVendor(id, vendorBody(), 1)).status).toBe(200);

    const stale = await h.updateVendor(id, vendorBody({ name: 'Renamed' }), 1);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await stored(h, id)).toEqual({
      name: 'Acme Supplies',
      contact_phone: null,
      version: 2,
    });
    expect(await h.vendorAudit()).toHaveLength(2);
  });

  it('[FR-VEN-01] the phone is cleared by null and by omission, stored as NULL; "" is 400', async () => {
    const h = await vendorsHarness();
    const id = await created(h, { contactPhone: '022 4000 1000' });

    const byNull = await h.updateVendor(id, vendorBody({ contactPhone: null }), 1);
    expect(byNull.status).toBe(200);
    expect(byNull.body).toMatchObject({ contactPhone: null });
    expect((await stored(h, id))?.contact_phone).toBeNull();

    expect((await h.updateVendor(id, vendorBody({ contactPhone: '022 1' }), 2)).status).toBe(200);
    const byOmission = await h.updateVendor(id, vendorBody(), 3);
    expect(byOmission.status).toBe(200);
    expect(byOmission.body).toMatchObject({ contactPhone: null });
    expect((await stored(h, id))?.contact_phone).toBeNull();

    const empty = await h.updateVendor(id, vendorBody({ contactPhone: '  ' }), 4);
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.contactPhone', code: 'TOO_SHORT' }],
    });
    expect((await stored(h, id))?.version).toBe(4);
  });

  it("[FR-VEN-01] a rename onto another vendor's normalised name is 409 naming it", async () => {
    const h = await vendorsHarness();
    const otherId = await h.seedVendor({ name: 'Bolt Traders', status: 'INACTIVE' });
    const id = await created(h);
    const clash = await h.updateVendor(id, vendorBody({ name: '  BOLT   traders' }), 1);
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: otherId, name: 'Bolt Traders' },
    });
    expect(await stored(h, id)).toMatchObject({ name: 'Acme Supplies', version: 1 });
    expect(await h.vendorAudit()).toHaveLength(1);
  });

  it('[FR-VEN-01] a vendor may change the case and spacing of its own name', async () => {
    const h = await vendorsHarness();
    const id = await created(h);
    const res = await h.updateVendor(id, vendorBody({ name: 'ACME  Supplies' }), 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'ACME Supplies', version: 2 });
  });

  it('[FR-VEN-01] an inactive vendor is editable and stays inactive', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Old Acme', status: 'INACTIVE' });
    const res = await h.updateVendor(id, vendorBody({ name: 'Old Acme Ltd' }), 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Old Acme Ltd',
      status: 'INACTIVE',
      deactivatedAt: expect.any(String) as unknown,
      version: 2,
    });
  });

  it('[FR-VEN-01] an unknown id is 404 and a non-UUID 400', async () => {
    const h = await vendorsHarness();
    const unknown = await h.updateVendor('6f1c2b8e-0000-4000-8000-000000000000', vendorBody(), 1);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await h.updateVendor('not-a-uuid', vendorBody(), 1)).status).toBe(400);
    expect(await h.vendorAudit()).toEqual([]);
  });

  it('[FR-VEN-01] system fields in the body are refused', async () => {
    const h = await vendorsHarness();
    const id = await created(h);
    const res = await h.updateVendor(id, vendorBody({ status: 'INACTIVE', version: 9 }), 1);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: expect.arrayContaining([
        { path: 'body.status', code: 'UNKNOWN_FIELD' },
        { path: 'body.version', code: 'UNKNOWN_FIELD' },
      ]) as unknown,
    });
  });
});

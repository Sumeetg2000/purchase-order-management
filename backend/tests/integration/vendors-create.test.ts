import { API_PATH_PREFIX } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { vendorBody, vendorsHarness } from '../support/vendors.js';

// Creating a vendor (spec US1; FR-001–FR-004, FR-013; research R2, R3): the stored form,
// the audit entry, and the duplicate-name answer naming the existing vendor.

describe('[FR-VEN-01] create a vendor', () => {
  it('[FR-VEN-01] a Buyer creates a vendor: 201 with ETag, Location, version 1 and ACTIVE', async () => {
    const h = await vendorsHarness();
    const res = await h.createVendor(
      vendorBody({
        name: '  Acme Supplies  ',
        contactName: ' Ravi Shah ',
        contactEmail: 'Ravi@ACME.example',
      }),
    );
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    expect(res.body).toEqual({
      id: expect.any(String) as unknown,
      name: 'Acme Supplies',
      contactName: 'Ravi Shah',
      contactEmail: 'ravi@acme.example',
      contactPhone: null,
      paymentTerms: { type: 'NET', netDays: 30 },
      status: 'ACTIVE',
      deactivatedAt: null,
      version: 1,
    });
    expect(res.get('ETag')).toBe('"1"');
    expect(res.get('Location')).toBe(`${API_PATH_PREFIX}/vendors/${id}`);

    const [row] = await h.query<{ name: string; contact_email: string; contact_phone: null }>(
      'SELECT name, contact_email, contact_phone FROM vendors WHERE id = $1',
      [id],
    );
    expect(row).toEqual({
      name: 'Acme Supplies',
      contact_email: 'ravi@acme.example',
      contact_phone: null,
    });
  });

  it('[FR-VEN-01] stores each payment-term type and a phone as sent', async () => {
    const h = await vendorsHarness();
    const advance = await h.createVendor(
      vendorBody({ name: 'Advance Co', paymentTerms: { type: 'ADVANCE' } }),
    );
    expect(advance.status).toBe(201);
    expect(advance.body).toMatchObject({ paymentTerms: { type: 'ADVANCE' } });
    const partial = await h.createVendor(
      vendorBody({
        name: 'Partial Co',
        contactPhone: ' +91 (22) 4000-1000 ',
        paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 30, netDays: 45 },
      }),
    );
    expect(partial.status).toBe(201);
    expect(partial.body).toMatchObject({
      contactPhone: '+91 (22) 4000-1000',
      paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 30, netDays: 45 },
    });
    const nullPhone = await h.createVendor(vendorBody({ name: 'Null Phone', contactPhone: null }));
    expect(nullPhone.body).toMatchObject({ contactPhone: null });
  });

  it('[FR-VEN-01] writes one VENDOR_CREATED entry with the full snapshot, acting as Buyer', async () => {
    const h = await vendorsHarness();
    const res = await h.createVendor(vendorBody({ contactPhone: '022 4000 1000' }));
    expect(res.status).toBe(201);
    expect(await h.vendorAudit()).toEqual([
      {
        action: 'VENDOR_CREATED',
        entity_type: 'vendor',
        entity_id: (res.body as { id: string }).id,
        actor_user_id: h.buyer.id,
        acting_role: 'BUYER',
        details: {
          before: null,
          after: {
            name: 'Acme Supplies',
            contactName: 'Ravi Shah',
            contactEmail: 'ravi@acme.example',
            contactPhone: '022 4000 1000',
            paymentTerms: { type: 'NET', netDays: 30 },
            status: 'ACTIVE',
          },
        },
      },
    ]);
  });

  it('[FR-VEN-01] a Buyer who is also an Approver creates as Buyer', async () => {
    const h = await vendorsHarness();
    const both = await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}' }));
    expect((await h.createVendor(vendorBody(), both)).status).toBe(201);
    const [entry] = await h.vendorAudit();
    expect(entry?.acting_role).toBe('BUYER');
  });

  it('[FR-VEN-01] a name differing only in case or spacing from an active vendor is 409 naming it', async () => {
    const h = await vendorsHarness();
    const first = await h.createVendor(vendorBody());
    const firstId = (first.body as { id: string }).id;
    const clash = await h.createVendor(vendorBody({ name: '\tACME   supplies ' }));
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: firstId, name: 'Acme Supplies' },
    });
    expect(await h.query('SELECT id FROM vendors')).toHaveLength(1);
    expect(await h.vendorAudit()).toHaveLength(1);
  });

  it('[FR-VEN-01] a name taken by an inactive vendor is 409 naming it, with no audit entry', async () => {
    const h = await vendorsHarness();
    const inactiveId = await h.seedVendor({ name: 'Old Acme', status: 'INACTIVE' });
    const clash = await h.createVendor(vendorBody({ name: 'old  ACME' }));
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: inactiveId, name: 'Old Acme' },
    });
    expect(await h.vendorAudit()).toEqual([]);
  });

  it('[FR-VEN-01] a retried identical create gets the same 409 naming the vendor it made', async () => {
    const h = await vendorsHarness();
    const first = await h.createVendor(vendorBody());
    const retry = await h.createVendor(vendorBody());
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: (first.body as { id: string }).id, name: 'Acme Supplies' },
    });
  });

  it('[FR-VEN-01] system fields and an empty phone are refused before anything is stored', async () => {
    const h = await vendorsHarness();
    const res = await h.createVendor(
      vendorBody({ status: 'INACTIVE', version: 7, contactPhone: '' }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: expect.arrayContaining([
        { path: 'body.status', code: 'UNKNOWN_FIELD' },
        { path: 'body.version', code: 'UNKNOWN_FIELD' },
        { path: 'body.contactPhone', code: 'TOO_SHORT' },
      ]) as unknown,
    });
    expect(await h.query('SELECT id FROM vendors')).toEqual([]);
  });
});

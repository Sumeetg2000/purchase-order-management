import { randomUUID } from 'node:crypto';
import { accountsHarness, type CookieJar } from './accounts.js';

// The real API with a logged-in Buyer, and helpers to create vendors through the API or
// seed them straight into the table (slice 2 vendor tests).

/** A valid create body; `extra` replaces or adds fields. */
export function vendorBody(extra: Record<string, unknown> = {}) {
  return {
    name: 'Acme Supplies',
    contactName: 'Ravi Shah',
    contactEmail: 'ravi@acme.example',
    paymentTerms: { type: 'NET', netDays: 30 },
    ...extra,
  };
}

export interface SeedVendor {
  name: string;
  status?: 'ACTIVE' | 'INACTIVE';
  contactPhone?: string | null;
}

export async function vendorsHarness() {
  const h = await accountsHarness();
  const buyer = await h.seedUser({ roles: '{BUYER}', name: 'Bea Buyer' });
  const jar = await h.loggedIn(buyer);

  function createVendor(body: unknown, as: CookieJar = jar) {
    return h.send('post', '/vendors', as, body);
  }

  /**
   * A vendor inserted as the superuser with triggers off (no audit entry), NET 30. The
   * generated name_key is still computed by PostgreSQL.
   */
  async function seedVendor({ name, status = 'ACTIVE', contactPhone = null }: SeedVendor) {
    const id = randomUUID();
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(
      `INSERT INTO vendors (id, name, contact_name, contact_email, contact_phone,
                            payment_term_type, net_days, status, deactivated_at)
       VALUES ($1, $2, 'Ravi Shah', 'ravi@acme.example', $3, 'NET', 30, $4,
               CASE WHEN $4 = 'INACTIVE' THEN now() END)`,
      [id, name, contactPhone, status],
    );
    await h.query('COMMIT');
    return id;
  }

  async function vendorAudit() {
    return h.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_user_id: string | null;
      acting_role: string | null;
      details: unknown;
    }>(
      `SELECT action, entity_type, entity_id, actor_user_id, acting_role, details
         FROM audit_entries WHERE entity_type = 'vendor' ORDER BY occurred_at, id`,
    );
  }

  return { ...h, buyer, jar, createVendor, seedVendor, vendorAudit };
}

export type VendorsHarness = Awaited<ReturnType<typeof vendorsHarness>>;

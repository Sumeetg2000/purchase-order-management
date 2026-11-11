import { PAGE_SIZE_DEFAULT, VENDOR_STATUS_FILTERS } from '@po/contracts';
import type pg from 'pg';
import { countEntityHistory, listEntityHistory } from '../../src/audit/repository.js';
import type { AppPrismaClient } from '../../src/db/client.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { countVendors, listVendors } from '../../src/vendors/repository.js';

// The vendor query-plan data and queries (research R11), shared by the plan test and the
// plan writer (`npm run plans:vendors`). Sizes from ADR-0012: 2,000 vendors (10 %
// inactive) and about 2M audit entries, 10,000 of them vendor entries. Every value comes
// from the series number, so the data, and so the plans, are the same on every run.

export const VENDOR_COUNT = 2_000;
export const AUDIT_ENTRY_COUNT = 2_000_000;
export const VENDOR_ENTRY_COUNT = 10_000;
/** Vendor 1 holds this many history entries; the rest are spread over the others. */
export const HOT_VENDOR_ENTRIES = 2_000;
/**
 * The name prefix the `q` queries search for: about 1 in 26 vendors start with it, and it
 * sorts late, so a plan that walks the name order and filters would show it.
 */
export const PLAN_QUERY_PREFIX = 'wil';
/** A later list page, so the plans show an offset too. */
export const DEEP_PAGE = 4;

const vendorId = (n: string) => `md5('plan-vendor-' || ${n})::uuid`;

/**
 * Seeds both tables, one INSERT … SELECT each, as the superuser with row triggers off (the
 * fill trigger would stamp every entry with one timestamp), then VACUUM ANALYZE.
 */
export async function seedVendorPlanData(superuser: pg.Client): Promise<void> {
  await superuser.query('BEGIN');
  await superuser.query('SET LOCAL session_replication_role = replica');
  await superuser.query(
    `INSERT INTO vendors (id, name, contact_name, contact_email, contact_phone,
                          payment_term_type, net_days, advance_percent, status, deactivated_at)
     SELECT ${vendorId('n')},
            (ARRAY['Acme','Bright','Coastal','Delta','Evergreen','Falcon','Granite','Harbor',
                   'Indigo','Juniper','Keystone','Lumen','Meridian','Northwind','Orchid',
                   'Pioneer','Quartz','Redwood','Summit','Tidal','Unity','Vertex','Willow',
                   'Xenon','Yarrow','Zenith'])[n % 26 + 1] || ' Supplies ' || n,
            'Contact ' || n, 'contact' || n || '@vendor.example',
            CASE WHEN n % 7 = 0 THEN NULL ELSE '+91 22 ' || lpad(n::text, 8, '0') END,
            (ARRAY['NET','ADVANCE','PARTIAL_ADVANCE'])[n % 3 + 1],
            CASE n % 3 WHEN 0 THEN 30 WHEN 2 THEN 45 END,
            CASE n % 3 WHEN 2 THEN 40 END,
            CASE WHEN n % 10 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END,
            CASE WHEN n % 10 = 0 THEN timestamptz '2026-01-01' END
       FROM generate_series(1, ${String(VENDOR_COUNT)}) AS n`,
  );
  // Every 200th entry is a vendor's: the first HOT_VENDOR_ENTRIES go to vendor 1, the rest
  // round the other vendors. The others are user entries.
  const every = AUDIT_ENTRY_COUNT / VENDOR_ENTRY_COUNT;
  await superuser.query(
    `INSERT INTO audit_entries (occurred_at, actor_type, action, entity_type, entity_id)
     SELECT timestamptz '2026-01-01' + n * interval '1 second', 'SYSTEM',
            CASE WHEN n % ${String(every)} = 0 THEN 'VENDOR_UPDATED' ELSE 'USER_UPDATED' END,
            CASE WHEN n % ${String(every)} = 0 THEN 'vendor' ELSE 'user' END,
            CASE WHEN n % ${String(every)} = 0
              THEN ${vendorId(`CASE WHEN n / ${String(every)} <= ${String(HOT_VENDOR_ENTRIES)} THEN 1
                     ELSE 2 + (n / ${String(every)} - ${String(HOT_VENDOR_ENTRIES + 1)}) % ${String(VENDOR_COUNT - 1)} END`)}::text
              ELSE md5('plan-user-' || n % 5000)::uuid::text END
       FROM generate_series(1, ${String(AUDIT_ENTRY_COUNT)}) AS n`,
  );
  await superuser.query('COMMIT');
  await superuser.query('VACUUM ANALYZE vendors, audit_entries');
}

/** The id the history queries read: vendor 1, the one with the most entries. */
export async function hotVendorId(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT ${vendorId('1')}::text AS id`);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no hot vendor id');
  return id;
}

export interface PlanQuery {
  /** The committed plan's file name, without `.txt`. */
  name: string;
  sql: Prisma.Sql;
  /** Page queries: no Seq Scan, no Sort over more than `rowsBound` rows. */
  page: boolean;
  /** Page size plus offset, for a page query. */
  rowsBound: number;
}

/** The SQL a repository function sends, captured instead of run. */
function captured(run: (db: AppPrismaClient) => Promise<unknown>): Prisma.Sql {
  let sql: Prisma.Sql | undefined;
  const db = {
    $queryRaw: (strings: TemplateStringsArray, ...values: Prisma.Sql[]) => {
      sql = Prisma.sql(strings, ...values);
      return Promise.resolve([]);
    },
  } as unknown as AppPrismaClient;
  void run(db);
  if (!sql) throw new Error('the repository function sent no query');
  return sql;
}

/** Every vendor list and history query the API runs, with the values it binds. */
export function vendorPlanQueries(vendorId: string): PlanQuery[] {
  const queries: PlanQuery[] = [];
  const limit = PAGE_SIZE_DEFAULT;
  for (const status of VENDOR_STATUS_FILTERS) {
    for (const q of [undefined, PLAN_QUERY_PREFIX]) {
      const filter = { status, q };
      const suffix = `${status.toLowerCase()}${q === undefined ? '' : '-q'}`;
      for (const page of [1, DEEP_PAGE]) {
        const offset = (page - 1) * limit;
        queries.push({
          name: `list-${suffix}-page-${String(page)}`,
          sql: captured((db) => listVendors(db, { ...filter, offset, limit })),
          page: true,
          rowsBound: limit + offset,
        });
      }
      queries.push({
        name: `count-${suffix}`,
        sql: captured((db) => countVendors(db, filter)),
        page: false,
        rowsBound: 0,
      });
    }
  }
  const entity = { entityType: 'vendor', entityId: vendorId } as const;
  for (const page of [1, DEEP_PAGE]) {
    const offset = (page - 1) * limit;
    queries.push({
      name: `history-page-${String(page)}`,
      sql: captured((db) => listEntityHistory(db, entity, { offset, limit })),
      page: true,
      rowsBound: limit + offset,
    });
  }
  queries.push({
    name: 'history-count',
    sql: captured((db) => countEntityHistory(db, entity)),
    page: false,
    rowsBound: 0,
  });
  return queries;
}

/** The query's values as SQL literals, for EXECUTE of a prepared statement. */
export function literals(client: pg.Client, sql: Prisma.Sql): string {
  return sql.values
    .map((v) => (typeof v === 'number' ? String(v) : client.escapeLiteral(String(v))))
    .join(', ');
}

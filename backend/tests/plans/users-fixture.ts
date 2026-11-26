import { PAGE_SIZE_DEFAULT } from '@po/contracts';
import type pg from 'pg';
import { accessRequestListSql } from '../../src/access-requests/repository.js';
import { listUsers } from '../../src/users/repository.js';
import { captured, type PlanQuery } from './vendors-fixture.js';

// The Admin's user and access-request lists at ADR-0012's user dataset (slice 7, closing
// ADR-0021; research R9): 10,000 users across every status and role set, with access
// requests open and closed. A fixed-seed generator in SQL: the same rows every run.

export const USER_COUNT = 10_000;
/** One open request per no-role user among the first ones: about 1,500. */
export const OPEN_REQUESTS = 1_500;
export const CLOSED_REQUESTS = 4_000;
/**
 * The prefix the search plans look for: names start with one of 26 syllables, so about 1
 * user in 26 matches, and it sorts late, so a walk of the name order that filters shows.
 */
export const USER_QUERY_PREFIX = 'wil';
/** A deep page, offset (DEEP_PAGE - 1) × page size: measured with no target (ADR-0012). */
export const DEEP_PAGE = 100;

const SYLLABLES = [
  'aar',
  'bal',
  'cha',
  'dev',
  'eka',
  'far',
  'gau',
  'har',
  'ish',
  'jai',
  'kav',
  'lak',
  'man',
  'nee',
  'oja',
  'pra',
  'qui',
  'rav',
  'san',
  'tar',
  'uma',
  'vik',
  'wil',
  'xia',
  'yas',
  'zoy',
];

const userId = (n: string) => `md5('plan-user-' || ${n})::uuid`;

/** ANALYZE samples 300 rows per target unit: at the maximum it reads every seeded row. */
const FULL_SAMPLE_STATISTICS_TARGET = 10_000;

export async function seedUserPlanData(superuser: pg.Client): Promise<void> {
  await superuser.query('BEGIN');
  await superuser.query('SET LOCAL session_replication_role = replica');
  // Roles by n mod 10: no role 2 in 10, Buyer 4, Approver 1, Buyer+Approver 2, and an
  // Admin 1 in 100 (in place of a Buyer); 1 in 20 deactivated, 1 in 20 unverified.
  await superuser.query(
    `INSERT INTO users (id, name, email, roles, status, deactivated_at, password_hash,
                        created_at, updated_at)
     SELECT ${userId('n')}, initcap(s.syllable || substr(md5(n::text), 1, 5)),
            s.syllable || substr(md5(n::text), 1, 5) || '.' || n || '@example.local',
            CASE WHEN n % 100 = 0 THEN '{ADMIN}'::text[]
                 WHEN n % 10 IN (0, 1) THEN '{}'::text[]
                 WHEN n % 10 IN (2, 3, 4, 5) THEN '{BUYER}'::text[]
                 WHEN n % 10 = 6 THEN '{APPROVER}'::text[]
                 ELSE '{BUYER,APPROVER}'::text[] END,
            CASE n % 20 WHEN 0 THEN 'DEACTIVATED' WHEN 1 THEN 'UNVERIFIED' ELSE 'ACTIVE' END,
            CASE WHEN n % 20 = 0 THEN now() - n * interval '1 minute' END,
            'plan-fixture-not-a-hash',
            now() - n * interval '2 minutes', now() - n * interval '1 minute'
       FROM generate_series(1, ${String(USER_COUNT)}) AS n
       CROSS JOIN LATERAL (
         SELECT (ARRAY['${SYLLABLES.join("','")}'])[(n * 7) % 26 + 1] AS syllable
       ) s`,
  );
  // Open requests from the first no-role users; closed ones (resolved, or dismissed with a
  // note) from others, decided by the fixture's first Admin (user 100).
  await superuser.query(
    `INSERT INTO access_requests (id, user_id, message, status, created_at, updated_at)
     SELECT md5('plan-open-request-' || u.n)::uuid, ${userId('u.n')}, 'Please give me access',
            'OPEN', now() - u.n * interval '3 minutes', now() - u.n * interval '3 minutes'
       FROM (SELECT n FROM generate_series(1, ${String(USER_COUNT)}) AS n
              WHERE n % 10 IN (0, 1) AND n % 100 <> 0 ORDER BY n LIMIT ${String(OPEN_REQUESTS)}) u`,
  );
  await superuser.query(
    `INSERT INTO access_requests (id, user_id, message, status, admin_note, decided_by,
                                  decided_at, created_at, updated_at)
     SELECT md5('plan-closed-request-' || n)::uuid, ${userId(`(n % ${String(USER_COUNT)}) + 1`)},
            'Please give me access',
            CASE WHEN n % 2 = 0 THEN 'RESOLVED' ELSE 'DISMISSED' END,
            CASE WHEN n % 2 = 1 THEN 'Use your team''s shared account' END,
            ${userId('100')}, now() - n * interval '4 minutes',
            now() - n * interval '5 minutes', now() - n * interval '4 minutes'
       FROM generate_series(1, ${String(CLOSED_REQUESTS)}) AS n`,
  );
  await superuser.query('COMMIT');
  await superuser.query(`SET default_statistics_target = ${String(FULL_SAMPLE_STATISTICS_TARGET)}`);
  await superuser.query('VACUUM ANALYZE users, access_requests');
  await superuser.query('RESET default_statistics_target');
}

/** Every Admin user-list and access-request-list query, with the values it binds. */
export function userPlanQueries(): PlanQuery[] {
  const queries: PlanQuery[] = [];
  const limit = PAGE_SIZE_DEFAULT;
  const userFilters: [
    string,
    Parameters<typeof listUsers>[1]['role'],
    Parameters<typeof listUsers>[1]['status'],
    string | undefined,
  ][] = [
    ['all', undefined, undefined, undefined],
    ['role-buyer', 'BUYER', undefined, undefined],
    ['role-none', 'NONE', undefined, undefined],
    ['status-active', undefined, 'ACTIVE', undefined],
    ['status-deactivated', undefined, 'DEACTIVATED', undefined],
    ['q', undefined, undefined, USER_QUERY_PREFIX],
  ];
  for (const [name, role, status, q] of userFilters) {
    for (const page of [1, DEEP_PAGE]) {
      const offset = (page - 1) * limit;
      queries.push({
        name: `users-${name}-page-${String(page)}`,
        sql: captured((db) => listUsers(db, { role, status, q, offset, limit })).page,
        page: true,
        rowsBound: offset + limit,
      });
    }
    queries.push({
      name: `users-${name}-count`,
      sql: captured((db) => listUsers(db, { role, status, q, offset: 0, limit })).count,
      page: false,
      rowsBound: 0,
    });
  }
  for (const [name, status] of [
    ['all', undefined],
    ['open', 'OPEN'],
    ['dismissed', 'DISMISSED'],
  ] as const) {
    for (const page of [1, DEEP_PAGE]) {
      const offset = (page - 1) * limit;
      queries.push({
        name: `access-requests-${name}-page-${String(page)}`,
        sql: accessRequestListSql({ status }, { offset, limit }).page,
        page: true,
        rowsBound: offset + limit,
      });
    }
    queries.push({
      name: `access-requests-${name}-count`,
      sql: accessRequestListSql({ status }, { offset: 0, limit }).count,
      page: false,
      rowsBound: 0,
    });
  }
  return queries;
}

/**
 * The admin-list plans that scan more than their page, accepted by the owner on
 * 2026-11-26 (ADR-0012, closing ADR-0021): each list holds at most 10,000 rows, and every
 * first page and count stays far under 200 ms (users.timing.test.ts). Any other query
 * that scans still fails the plan test.
 */
export const PLAN_EXCEPTIONS: Readonly<Record<string, string>> = {
  'users-role-none-page-1': 'no-role users filtered out of name order (no index on roles)',
  'users-role-none-page-100': 'no-role users filtered out of name order (no index on roles)',
  'users-q-page-1':
    'name-or-email prefix filtered out of name order (OR defeats both prefix indexes)',
  'users-q-page-100':
    'name-or-email prefix filtered out of name order (OR defeats both prefix indexes)',
  'users-role-buyer-count':
    'role is an array element: counted by reading users (no index on roles)',
  'users-role-none-count': 'no-role users counted by reading users (no index on roles)',
  'users-status-active-count': 'about 90% of users are active: a scan beats the status index',
  'access-requests-open-page-100': 'page 100 is past the 1,500 open requests: nothing to stop at',
  'access-requests-dismissed-page-100':
    'page 100 is at the end of the 2,000 dismissed: nothing to stop at',
};

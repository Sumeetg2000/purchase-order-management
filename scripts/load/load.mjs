// The brief's §8 load test (specs/008-outstanding-report/research.md R7–R8; ADR-0012,
// amended 2026-11-26), run by scripts/load/run.sh against the isolated po-load stack. Plain
// Node and fetch: 20 Buyers raise the seeded plan's 10,000 orders across 200 vendors
// through the HTTP API while 2 Approvers decide and cancel; receipts follow the plan. Then
// the guarded age shift, the report timings, one call of every read the UI offers, the
// outstanding-by-age plan, the unused-index check and reconciliation; one record is
// written. The run fails (exit 1) on any 5xx or timeout, any reconciliation row, or an
// unexplained unused index.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RECEIPT_TIME_ZONE, ROLE } from '@po/contracts';
import { backdate, LOAD_PROJECT, queryLoadDb } from './backdate.mjs';
import { checkIndexUsage, INDEX_USAGE_SQL } from './indexes.mjs';
import { buildLoadPlan, LOAD_SIZES } from './plan.mjs';
import { failuresOf, renderRunRecord } from './record.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = required('APP_ORIGIN');
const MAILPIT = required('MAILPIT_URL');
const ENV_FILE = required('COMPOSE_ENV_FILES');
const PROJECT = required('COMPOSE_PROJECT_NAME');
const SEED = Number(process.env.LOAD_SEED ?? 20261126);
const REQUEST_TIMEOUT_MS = 30_000;
const WARM_UP_RUNS = 3;
const TIMED_RUNS = 50;
/** ADR-0012's p95 targets for the report and its vendor summary. */
const REPORT_P95_MS = 200;
const VENDOR_SUMMARY_P95_MS = 300;
/** The per-address limits every signup and login from one machine shares (ADR-0017). */
const SHARED_BUCKETS = ['login-ip', 'signup-ip'];
const SIGNUP_DOMAIN = 'example.local';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`load: ${name} is not set (run scripts/load/run.sh)`);
  return value;
}

const statusCounts = {};
let timeouts = 0;
const log = (line) => console.info(`load: ${line}`);

/** One signed-in user: cookies, the CSRF header, a refresh when the access token expires. */
class Client {
  cookies = new Map();
  refreshing = null;

  async req(method, path, body, headers = {}, retried = false) {
    const h = { Origin: ORIGIN, Accept: 'application/json', ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && this.cookies.has('po_csrf'))
      h['X-CSRF-Token'] = this.cookies.get('po_csrf');
    if (body !== undefined) h['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${ORIGIN}/api${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        timeouts += 1;
        return { status: 0, body: undefined, headers: new Headers() };
      }
      throw error;
    }
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    // An expired access token is the protocol, not an error: refresh once and retry.
    if (res.status === 401 && json?.code === 'ACCESS_TOKEN_EXPIRED' && !retried) {
      this.refreshing ??= this.req('POST', '/auth/refresh', undefined, {}, true).finally(() => {
        this.refreshing = null;
      });
      await this.refreshing;
      return this.req(method, path, body, headers, true);
    }
    statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
    return { status: res.status, body: json, headers: res.headers };
  }

  async ok(method, path, body, headers, expected = [200, 201, 204]) {
    const res = await this.req(method, path, body, headers);
    if (!expected.includes(res.status)) {
      throw new Error(
        `${method} ${path}: ${String(res.status)} ${JSON.stringify(res.body).slice(0, 300)}`,
      );
    }
    return res.body;
  }
}

async function login(email, password) {
  const c = new Client();
  await c.ok('POST', '/auth/login', { email, password });
  return c;
}

function compose(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' });
}

function clearSharedLimits() {
  const buckets = SHARED_BUCKETS.map((b) => `'${b}'`).join(', ');
  queryLoadDb({
    projectName: PROJECT,
    envFile: ENV_FILE,
    sql: `DELETE FROM rate_limit_counters WHERE bucket IN (${buckets});`,
  });
}

async function mailToken(address, page) {
  for (let i = 0; i < 120; i += 1) {
    const search = await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)
    ).json();
    const message = search.messages?.[0];
    if (message) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
      const token = new RegExp(`${page}#token=([A-Za-z0-9_-]+)`).exec(full.Text)?.[1];
      if (token) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no ${page} mail for ${address}`);
}

const password = () => randomBytes(18).toString('base64url');
const etag = (version) => `"${String(version)}"`;
const indiaToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: RECEIPT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** An Admin from the operator CLI, signed in. */
async function admin() {
  const email = `load-admin-${randomUUID().slice(0, 8)}@${SIGNUP_DOMAIN}`;
  const out = compose(
    'exec',
    '-T',
    'api',
    'npm',
    'run',
    '-s',
    'admin',
    '--',
    'admin:create',
    '--email',
    email,
    '--name',
    'Load Admin',
  );
  const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(out)?.[1];
  if (!token) throw new Error('admin:create printed no set-password link');
  const secret = password();
  await new Client().ok('POST', '/auth/reset-password', { token, newPassword: secret });
  return login(email, secret);
}

/** A signed-up, verified user given `roles` by the Admin, signed in. */
async function member(adminClient, name, roles) {
  const email = `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 6)}@${SIGNUP_DOMAIN}`;
  const secret = password();
  await new Client().ok(
    'POST',
    '/auth/signup',
    { name, email, password: secret },
    {},
    [200, 201, 202, 204],
  );
  const token = await mailToken(email, '/verify-email');
  await new Client().ok('POST', '/auth/verify-email', { token, password: secret });
  const users = await adminClient.ok(
    'GET',
    `/admin/users?q=${encodeURIComponent(email)}&pageSize=5`,
  );
  const user = users.items.find((u) => u.email === email);
  const detail = await adminClient.req('GET', `/admin/users/${user.id}`);
  await adminClient.ok(
    'PATCH',
    `/admin/users/${user.id}`,
    { roles },
    { 'If-Match': detail.headers.get('etag') },
  );
  return { id: user.id, client: await login(email, secret) };
}

/** Raises, decides, receives and cancels one planned order through the API. */
async function carryOut(order, buyer, approver, vendorIds, today) {
  const created = await buyer.ok(
    'POST',
    '/orders',
    {
      vendorId: vendorIds[order.vendor],
      lines: order.lines.map((line, i) => ({
        description: `Load part ${String(order.index)}-${String(i + 1)}`,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    },
    { 'Idempotency-Key': randomUUID() },
  );
  let current = await buyer.ok('POST', `/orders/${created.id}/submit`, undefined, {
    'If-Match': etag(created.version),
  });
  if (order.route === 'reject') {
    await approver.ok(
      'POST',
      `/orders/${current.id}/reject`,
      { reason: 'Load test rejection' },
      { 'If-Match': etag(current.version) },
    );
    return { id: current.id, ageDays: order.ageDays, receipts: 0 };
  }
  if (order.route === 'approve') {
    current = await approver.ok('POST', `/orders/${current.id}/approve`, undefined, {
      'If-Match': etag(current.version),
    });
  }
  for (const receipt of order.receipts) {
    await buyer.ok(
      'POST',
      `/orders/${current.id}/receipts`,
      {
        receivedOn: today,
        lines: receipt.flatMap((quantity, i) =>
          quantity > 0 ? [{ lineId: created.lines[i].id, quantity }] : [],
        ),
      },
      { 'Idempotency-Key': randomUUID() },
    );
  }
  if (order.cancel) {
    // A receipt never moves the order's version (ADR-0016).
    await approver.ok(
      'POST',
      `/orders/${current.id}/cancel`,
      { reason: 'Load test cancel' },
      { 'If-Match': etag(current.version) },
    );
  }
  return { id: current.id, ageDays: order.ageDays, receipts: order.receipts.length };
}

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0);
}

async function timed(client, path, target) {
  const samples = [];
  for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
    const started = performance.now();
    await client.ok('GET', path);
    if (run >= WARM_UP_RUNS) samples.push(performance.now() - started);
  }
  return { p95: p95(samples), target };
}

async function main() {
  if (PROJECT !== LOAD_PROJECT) throw new Error(`load: refusing to run against ${PROJECT}`);
  const started = Date.now();
  const plan = buildLoadPlan({ seed: SEED });
  const today = indiaToday();

  log('accounts');
  const adminClient = await admin();
  const buyers = [];
  const approvers = [];
  for (let i = 0; i < LOAD_SIZES.buyers + LOAD_SIZES.approvers; i += 1) {
    if (i % 5 === 0) clearSharedLimits();
    const isBuyer = i < LOAD_SIZES.buyers;
    const who = await member(
      adminClient,
      isBuyer
        ? `Load Buyer ${String(i + 1)}`
        : `Load Approver ${String(i - LOAD_SIZES.buyers + 1)}`,
      [isBuyer ? ROLE.BUYER : ROLE.APPROVER],
    );
    (isBuyer ? buyers : approvers).push(who);
  }

  log('vendors');
  const vendorIds = [];
  for (const [i, vendor] of plan.vendors.entries()) {
    const created = await buyers[i % buyers.length].client.ok('POST', '/vendors', {
      name: vendor.name,
      contactName: 'Load Contact',
      contactEmail: `vendor${String(i + 1)}@vendor.example`,
      paymentTerms: { type: 'NET', netDays: 30 },
    });
    vendorIds.push(created.id);
  }

  log(`orders: ${String(plan.orders.length)} by ${String(buyers.length)} virtual users`);
  const results = await Promise.all(
    buyers.map(async (buyer, b) => {
      const mine = plan.orders.filter((o) => o.buyer === b);
      const done = [];
      for (const order of mine) {
        done.push(
          await carryOut(
            order,
            buyer.client,
            approvers[order.index % approvers.length].client,
            vendorIds,
            today,
          ),
        );
      }
      return done;
    }),
  );
  const orders = results.flat();
  const trafficMs = Date.now() - started;
  log(`traffic done in ${String(Math.round(trafficMs / 1000))} s`);

  await backdate({
    projectName: PROJECT,
    envFile: ENV_FILE,
    ages: orders.map((o) => ({ orderId: o.id, days: o.ageDays })),
    log,
  });

  log('report timings');
  const busiestVendor = vendorIds[0];
  const timings = {
    'report, Admin, page 1': await timed(adminClient, '/reports/outstanding', REPORT_P95_MS),
    'report, Admin, one vendor': await timed(
      adminClient,
      `/reports/outstanding?vendorId=${busiestVendor}`,
      REPORT_P95_MS,
    ),
    'report, Admin, over 90 days': await timed(
      adminClient,
      '/reports/outstanding?ageBucket=OVER_90',
      REPORT_P95_MS,
    ),
    'report, a Buyer, page 1': await timed(buyers[0].client, '/reports/outstanding', REPORT_P95_MS),
    'vendor summary, Admin': await timed(
      adminClient,
      '/reports/outstanding/vendors',
      VENDOR_SUMMARY_P95_MS,
    ),
  };

  log('every read the UI offers, once');
  const anOrder = orders.find((o) => o.receipts > 0);
  const receiptsPage = await buyers[0].client
    .ok('GET', `/orders/${anOrder.id}/receipts`)
    .catch(() => null);
  const admin0 = adminClient;
  const buyer0 = buyers[0].client;
  const approver0 = approvers[0].client;
  const reads = [
    [buyer0, '/me'],
    [buyer0, '/auth/sessions'],
    [buyer0, '/approval-policy'],
    [buyer0, '/vendors'],
    [buyer0, '/vendors?status=ALL&q=Load'],
    [buyer0, '/vendors?status=INACTIVE'],
    [buyer0, `/vendors/${busiestVendor}`],
    [buyer0, `/vendors/${busiestVendor}/history`],
    [buyer0, '/orders'],
    [buyer0, '/orders?status=APPROVED'],
    [buyer0, `/orders?vendorId=${busiestVendor}`],
    [buyer0, '/orders?poNumber=PO-'],
    [buyer0, `/orders?createdFrom=${today}&createdTo=${today}`],
    [buyer0, '/orders?page=2'],
    [approver0, '/orders'],
    [approver0, '/orders?status=PENDING_APPROVAL'],
    [approver0, '/approvals'],
    [approver0, `/approvals?vendorId=${busiestVendor}`],
    [admin0, '/orders'],
    [admin0, '/orders?status=CANCELLED'],
    [admin0, `/orders/${anOrder.id}`],
    [admin0, `/orders/${anOrder.id}/timeline`],
    [admin0, `/orders/${anOrder.id}/receipts`],
    ...(receiptsPage?.items?.[0]
      ? [[admin0, `/orders/${anOrder.id}/receipts/${receiptsPage.items[0].id}`]]
      : []),
    [admin0, '/admin/users'],
    [admin0, '/admin/users?role=BUYER'],
    [admin0, '/admin/users?role=NONE'],
    [admin0, '/admin/users?status=ACTIVE'],
    [admin0, '/admin/users?q=load'],
    [admin0, `/admin/users/${buyers[0].id}`],
    [admin0, '/admin/access-requests'],
    [admin0, '/admin/access-requests?status=OPEN'],
    [admin0, '/reports/outstanding?ageBucket=DAYS_0_30'],
    [admin0, `/reports/outstanding?vendorId=${busiestVendor}&ageBucket=OVER_90`],
    [buyer0, '/reports/outstanding/vendors'],
  ];
  for (const [client, path] of reads) await client.ok('GET', path);

  log('outstanding-by-age plan');
  // The as-of date the API counts with now (a run may cross India midnight after `today`).
  const { asOf } = await adminClient.ok('GET', '/reports/outstanding?pageSize=1');
  const explain = execFileSync(
    'npx',
    ['tsx', 'backend/scripts/outstanding-sql.ts', '--as-of', asOf, '--bucket', 'OVER_90'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  const plan90 = queryLoadDb({ projectName: PROJECT, envFile: ENV_FILE, sql: explain });
  mkdirSync(`${ROOT}docs/query-plans/load`, { recursive: true });
  writeFileSync(
    `${ROOT}docs/query-plans/load/outstanding-by-age.txt`,
    `-- The outstanding report, over 90 days, as the Admin sees it, on the load test's data\n` +
      `-- (10,000 orders, 200 vendors; as of ${asOf}). Page with its count, then the count.\n` +
      `-- Values are inlined as literals (a custom plan); the generic plan, as the API's\n` +
      `-- prepared statement may use it, is checked at 100,000 orders by orders.plan.test.ts.\n\n${plan90}`,
  );

  log('index usage and reconciliation');
  const usage = queryLoadDb({ projectName: PROJECT, envFile: ENV_FILE, sql: `${INDEX_USAGE_SQL};` })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, scans] = line.split('|');
      return { index, scans: Number(scans) };
    });
  const expected = JSON.parse(
    readFileSync(new URL('./expected-unused-indexes.json', import.meta.url), 'utf8'),
  );
  const indexes = checkIndexUsage(usage, expected);
  const reconciliation = queryLoadDb({
    projectName: PROJECT,
    envFile: ENV_FILE,
    sql: readFileSync(`${ROOT}backend/src/db/reconciliation.sql`, 'utf8'),
  }).trim();

  const result = {
    date: today,
    // -dirty when the run used uncommitted changes, so the record never overstates.
    commit: execFileSync('git', ['describe', '--always', '--dirty'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    durationMs: Date.now() - started,
    dataset: {
      orders: orders.length,
      vendors: vendorIds.length,
      buyers: buyers.length,
      approvers: approvers.length,
      receipts: orders.reduce((n, o) => n + o.receipts, 0),
    },
    statusCounts,
    timeouts,
    timings,
    reconciliationRows: reconciliation === '' ? 0 : reconciliation.split('\n').length,
    indexes,
    unused: usage.filter((u) => u.scans === 0).map((u) => u.index),
  };
  mkdirSync(`${ROOT}reports/load`, { recursive: true });
  writeFileSync(`${ROOT}reports/load/result.json`, `${JSON.stringify(result, null, 2)}\n`);
  mkdirSync(`${ROOT}docs/perf`, { recursive: true });
  writeFileSync(`${ROOT}docs/perf/load-run.md`, renderRunRecord(result));
  const failures = failuresOf(result);
  for (const failure of failures) log(`FAILED: ${failure}`);
  log(failures.length === 0 ? 'passed' : 'failed');
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

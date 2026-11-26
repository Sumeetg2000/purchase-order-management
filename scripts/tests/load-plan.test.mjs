// The load test's seeded plan (specs/008-outstanding-report/research.md R7): what the
// 10,000-order run raises, approves, rejects, receives and cancels, decided before it
// starts, the same for the same seed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPROVAL_POLICY_SEED_TIERS, lineTotal, moneyAbove, sum, toMoney } from '@po/contracts';
import { buildLoadPlan, LOAD_SIZES } from '../load/plan.mjs';

const plan = buildLoadPlan({ seed: 7 });
const share = (n) => n / plan.orders.length;
// Exact decimals, as the API routes them (ADR-0010).
const total = (order) =>
  sum(order.lines.map((line) => lineTotal(line.quantity, toMoney(line.unitPrice))));
const threshold = toMoney(APPROVAL_POLICY_SEED_TIERS[0]);

describe('[NFR-PERF-02] the load test plan', () => {
  it('[NFR-PERF-02] 10,000 orders across 200 vendors, 20 Buyers and 2 Approvers', () => {
    assert.deepEqual(LOAD_SIZES, { orders: 10_000, vendors: 200, buyers: 20, approvers: 2 });
    assert.equal(plan.orders.length, 10_000);
    assert.equal(plan.vendors.length, 200);
    assert.equal(new Set(plan.vendors.map((v) => v.name)).size, 200);
    assert.equal(new Set(plan.orders.map((o) => o.vendor)).size, 200);
    assert.equal(new Set(plan.orders.map((o) => o.buyer)).size, 20);
    for (const order of plan.orders) {
      assert.ok(order.vendor >= 0 && order.vendor < 200);
      assert.ok(order.buyer >= 0 && order.buyer < 20);
    }
  });

  it('[NFR-PERF-02] 1–5 lines, 1 in 100 orders with 50–100', () => {
    const wide = plan.orders.filter((o) => o.lines.length >= 50);
    assert.ok(share(wide.length) > 0.005 && share(wide.length) < 0.02, `wide ${wide.length}`);
    for (const order of plan.orders) {
      const n = order.lines.length;
      assert.ok((n >= 1 && n <= 5) || (n >= 50 && n <= 100), `lines ${n}`);
      for (const line of order.lines)
        assert.ok(Number.isInteger(line.quantity) && line.quantity >= 1);
    }
  });

  it('[NFR-PERF-02] about 85% at or below the tier, auto-approved; the rest approved or, 1 in 5, rejected', () => {
    for (const order of plan.orders) {
      assert.equal(order.route === 'auto', !moneyAbove(total(order), threshold), order.route);
    }
    const auto = plan.orders.filter((o) => o.route === 'auto').length;
    const rejected = plan.orders.filter((o) => o.route === 'reject').length;
    const routed = plan.orders.length - auto;
    assert.ok(share(auto) > 0.8 && share(auto) < 0.9, `auto ${auto}`);
    assert.ok(
      rejected / routed > 0.12 && rejected / routed < 0.28,
      `rejected ${rejected}/${routed}`,
    );
  });

  it('[NFR-PERF-02] receipt histories: none, partly, fully; never more than ordered; about 3% cancelled', () => {
    const approved = plan.orders.filter((o) => o.route !== 'reject');
    const counts = { none: 0, partly: 0, fully: 0 };
    for (const order of approved) {
      const received = order.lines.map((_, i) =>
        order.receipts.reduce((sum, receipt) => sum + (receipt[i] ?? 0), 0),
      );
      received.forEach((r, i) => assert.ok(r <= (order.lines[i]?.quantity ?? 0)));
      assert.ok(order.receipts.length <= 3);
      for (const receipt of order.receipts) assert.ok(receipt.some((q) => q > 0));
      const full = received.every((r, i) => r === order.lines[i]?.quantity);
      const kind = order.receipts.length === 0 ? 'none' : full ? 'fully' : 'partly';
      counts[kind] += 1;
      if (order.cancel) assert.notEqual(kind, 'fully', 'a fully received order is never cancelled');
    }
    const of = (n) => n / approved.length;
    assert.ok(of(counts.none) > 0.25 && of(counts.none) < 0.35, `none ${counts.none}`);
    assert.ok(of(counts.partly) > 0.3 && of(counts.partly) < 0.4, `partly ${counts.partly}`);
    assert.ok(of(counts.fully) > 0.3 && of(counts.fully) < 0.4, `fully ${counts.fully}`);
    const cancelled = approved.filter((o) => o.cancel).length;
    assert.ok(of(cancelled) > 0.02 && of(cancelled) < 0.04, `cancelled ${cancelled}`);
    for (const order of plan.orders.filter((o) => o.route === 'reject')) {
      assert.deepEqual(order.receipts, []);
      assert.equal(order.cancel, false);
    }
  });

  it('[NFR-PERF-02] ages for the backdate: whole days from 0 to 180', () => {
    for (const order of plan.orders) {
      assert.ok(Number.isInteger(order.ageDays) && order.ageDays >= 0 && order.ageDays <= 180);
    }
    assert.ok(new Set(plan.orders.map((o) => o.ageDays)).size > 150);
  });

  it('[NFR-PERF-02] the same seed gives the same plan; another seed another', () => {
    assert.deepEqual(buildLoadPlan({ seed: 7 }), plan);
    assert.notDeepEqual(buildLoadPlan({ seed: 8 }).orders.slice(0, 50), plan.orders.slice(0, 50));
  });
});

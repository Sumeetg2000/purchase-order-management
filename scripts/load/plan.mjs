// The load test's seeded plan (specs/008-outstanding-report/research.md R7; ADR-0012's
// brief §8 scenario): every order the run raises, decided before it starts, so the same
// seed always drives the same traffic. The run (load.mjs) carries it out through the API;
// the backdate (backdate.mjs) applies each order's age afterwards.
import { APPROVAL_POLICY_SEED_TIERS } from '@po/contracts';

export const LOAD_SIZES = { orders: 10_000, vendors: 200, buyers: 20, approvers: 2 };

/** Shares of the mix (research R7). */
const AUTO_SHARE = 0.85;
const REJECT_SHARE_OF_ROUTED = 0.2;
const WIDE_SHARE = 0.01;
const NO_RECEIPT_SHARE = 0.3;
const PARTLY_SHARE = 0.35;
/** About 3% of approved orders cancelled, drawn among those not fully received. */
const CANCEL_SHARE = 0.03;
const MAX_AGE_DAYS = 180;
const MAX_RECEIPTS = 3;

/** A small, fast, seeded PRNG (mulberry32): the same seed, the same sequence. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Splits `quantity` into `parts` non-negative whole numbers that add up to it. */
function split(next, quantity, parts) {
  const cuts = Array.from({ length: parts - 1 }, () => Math.floor(next() * (quantity + 1)));
  cuts.sort((a, b) => a - b);
  return [...cuts, quantity].map((cut, i) => cut - (i === 0 ? 0 : (cuts[i - 1] ?? 0)));
}

export function buildLoadPlan({ seed }) {
  const next = random(seed);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const threshold = Number(APPROVAL_POLICY_SEED_TIERS[0]);

  const vendors = Array.from({ length: LOAD_SIZES.vendors }, (_, i) => ({
    name: `Load Vendor ${String(i + 1).padStart(3, '0')}`,
  }));

  const orders = Array.from({ length: LOAD_SIZES.orders }, (_, i) => {
    const wide = next() < WIDE_SHARE;
    const auto = next() < AUTO_SHARE;
    const lines = Array.from({ length: wide ? int(50, 100) : int(1, 5) }, () =>
      wide
        ? { quantity: int(1, 5), unitPrice: String(int(1, 150)) }
        : { quantity: int(1, 20), unitPrice: String(int(1, 900)) },
    );
    if (!auto) {
      // Above the tier: one line alone exceeds it.
      lines[0] = { quantity: 1, unitPrice: String(int(threshold + 1, threshold * 4)) };
    }
    const route = auto ? 'auto' : next() < REJECT_SHARE_OF_ROUTED ? 'reject' : 'approve';

    let receipts = [];
    let cancel = false;
    if (route !== 'reject') {
      const draw = next();
      const units = lines.reduce((sum, line) => sum + line.quantity, 0);
      const kind =
        draw < NO_RECEIPT_SHARE
          ? 'none'
          : draw < NO_RECEIPT_SHARE + PARTLY_SHARE && units >= 2
            ? 'partly'
            : draw < NO_RECEIPT_SHARE + PARTLY_SHARE
              ? 'none'
              : 'fully';
      if (kind !== 'none') {
        const count = int(1, MAX_RECEIPTS);
        // Per line, its quantity split across the receipts; partly: one unit held back.
        const perLine = lines.map((line) => split(next, line.quantity, count));
        if (kind === 'partly') {
          const held = perLine.findIndex((parts) => parts.some((q) => q > 0));
          const parts = perLine[held];
          const last = parts.findLastIndex((q) => q > 0);
          parts[last] -= 1;
        }
        receipts = Array.from({ length: count }, (_, r) => perLine.map((parts) => parts[r] ?? 0))
          // A receipt records at least one unit.
          .filter((receipt) => receipt.some((q) => q > 0));
      }
      // Cancelled after its receipts (if any); a fully received order is never cancelled.
      const fully = kind === 'fully';
      cancel = !fully && next() < CANCEL_SHARE / (1 - (1 - NO_RECEIPT_SHARE - PARTLY_SHARE));
    }
    return {
      index: i,
      buyer: i % LOAD_SIZES.buyers,
      vendor: int(0, LOAD_SIZES.vendors - 1),
      lines,
      route,
      receipts,
      cancel,
      ageDays: int(0, MAX_AGE_DAYS),
    };
  });
  // Every vendor gets orders: the first 200 orders take one each.
  for (let v = 0; v < LOAD_SIZES.vendors; v += 1) {
    const order = orders[v];
    if (order) order.vendor = v;
  }
  return { seed, vendors, orders };
}

import { describe, expect, it } from 'vitest';
import { reportsHarness } from '../support/reports.js';

// Who sees what in the outstanding report and its vendor summary (specs/008-outstanding-
// report, US3; ADR-0004's "Outstanding report and order lists" row): a Buyer their own
// orders only; an Approver, an Admin and a Buyer+Approver all. No role (403) and no
// session (401) are cells of the authorization matrix.

describe('[FR-OWN-01] the outstanding report is scoped to what the caller may read', () => {
  it('[FR-OWN-01] each Buyer sees and counts only their own; Approver, Admin and Buyer+Approver see all', async () => {
    const h = await reportsHarness();
    const two = await h.caller('{BUYER}', 'Bo Buyer');
    const mine = await h.approvedOn(h.vendorId);
    const theirs = await h.approvedOn(h.vendorId, [10], two.jar);

    const seenBy = async (jar: typeof h.jar) => {
      const report = await h.report(jar);
      const summary = await h.vendorSummary(jar);
      expect([report.status, summary.status]).toEqual([200, 200]);
      const page = report.body as { items: { id: string }[]; total: number };
      const vendors = summary.body as { items: { orderCount: number }[] };
      return {
        ids: page.items.map((i) => i.id).sort(),
        total: page.total,
        counted: vendors.items.reduce((n, v) => n + v.orderCount, 0),
      };
    };

    expect(await seenBy(h.jar)).toEqual({ ids: [mine.id], total: 1, counted: 1 });
    expect(await seenBy(two.jar)).toEqual({ ids: [theirs.id], total: 1, counted: 1 });
    const both = { ids: [mine.id, theirs.id].sort(), total: 2, counted: 2 };
    for (const roles of ['{APPROVER}', '{ADMIN}', '{BUYER,APPROVER}']) {
      const caller = await h.caller(roles);
      expect(await seenBy(caller.jar), roles).toEqual(both);
    }
  });
});

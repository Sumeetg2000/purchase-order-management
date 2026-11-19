import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { order, ORDER_ID, pendingOrder, policy } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The four order dialogs (contracts/ui.md, ADR-0018): a failure meaning the order behind
// the dialog has changed (its version, its state, or it is no longer readable) offers
// "Reload order", which rereads the order and closes the dialog.

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { ...ME, id: order().owner.id, roles: ['BUYER'] };
const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };

const DIALOGS = [
  { name: 'Submit', user: OWNER, shown: order({ total: '150000.0000' }), action: 'submit' },
  { name: 'Approve', user: APPROVER, shown: pendingOrder(), action: 'approve' },
  { name: 'Reject', user: APPROVER, shown: pendingOrder(), action: 'reject' },
  { name: 'Withdraw', user: OWNER, shown: pendingOrder(), action: 'withdraw' },
] as const;

const STALE = [
  [409, 'VERSION_CONFLICT'],
  [409, 'INVALID_STATE_TRANSITION'],
  [404, 'NOT_FOUND'],
] as const;

describe('[NFR-FE-09] Reload order when the order behind a dialog changed', () => {
  for (const dialog of DIALOGS) {
    for (const [status, code] of STALE) {
      it(`[NFR-FE-09] ${dialog.name}: ${code} offers Reload order, which rereads the order`, async () => {
        const seen = fakeApi({
          'GET /me': () => json(200, dialog.user),
          [`GET /orders/${ORDER_ID}`]: () => json(200, dialog.shown, { ETag: '"2"' }),
          'GET /approval-policy': () => json(200, policy()),
          'GET /approvals': () => json(200, page([])),
          'GET /orders': () => json(200, page([])),
          [`POST /orders/${ORDER_ID}/${dialog.action}`]: () => problem(status, code),
        });
        const { user } = renderApp(`/orders/${ORDER_ID}`);
        await user.click(await screen.findByRole('button', { name: dialog.name, exact: true }));
        const box = await screen.findByRole('alertdialog');
        const reason = within(box).queryByLabelText('Reason');
        if (reason) await user.type(reason, 'Not needed any more');
        await user.click(within(box).getByRole('button', { name: dialog.name, exact: true }));
        const reload = await within(box).findByRole('button', { name: 'Reload order' });
        const reads = () =>
          seen.filter((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith(ORDER_ID))
            .length;
        const before = reads();
        await user.click(reload);
        await waitFor(() => {
          expect(reads()).toBeGreaterThan(before);
        });
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });
    }
  }
});

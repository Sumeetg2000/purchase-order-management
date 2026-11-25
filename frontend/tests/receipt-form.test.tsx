import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { approvedOrder, order, orderLine, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// Record receipt (contracts/ui.md; spec FR-019, US1, US2): the owner of an approved order
// with something outstanding opens a form over the lines still to come, enters what
// arrived, and confirms in a dialog that says, per line, what the receipt does. One
// Idempotency-Key per opened dialog, reused on retry; one request on a double click.

afterEach(() => {
  vi.unstubAllGlobals();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER = { ...ME, id: order().owner.id, roles: ['BUYER'] };
const LINE_B = '0192e4a0-0000-7000-8000-0000000000c2';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

/** Washers 40 of 100 received; Bolts 7 of 7 (nothing outstanding). */
const partly = () =>
  approvedOrder({
    lines: [
      orderLine({ quantity: 100, receivedQuantity: 40 }),
      orderLine({ id: LINE_B, description: 'Bolts', quantity: 7, receivedQuantity: 7 }),
    ],
    receiptProgress: 'PARTIALLY_RECEIVED',
  });

const recorded = {
  id: '0192e4a0-0000-7000-8000-0000000000d1',
  receivedOn: TODAY,
  recordedAt: '2026-11-25T04:00:00.000Z',
  note: null,
  receiptProgress: 'FULLY_RECEIVED',
  lines: [
    {
      lineId: orderLine().id,
      position: 0,
      quantity: 60,
      receivedBefore: 40,
      receivedAfter: 100,
      outstandingAfter: 0,
    },
  ],
};

function show(
  shown: Record<string, unknown>,
  {
    user = OWNER,
    post = () => json(201, recorded),
  }: { user?: Record<string, unknown>; post?: () => Response } = {},
) {
  const seen = fakeApi({
    'GET /me': () => json(200, user),
    [`GET /orders/${ORDER_ID}`]: () => json(200, shown, { ETag: '"3"' }),
    [`GET /orders/${ORDER_ID}/receipts`]: () => json(200, page([])),
    [`POST /orders/${ORDER_ID}/receipts`]: post,
    'GET /approvals': () => json(200, page([])),
    'GET /orders': () => json(200, page([])),
  });
  return { ...renderApp(`/orders/${ORDER_ID}`), seen };
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
const posts = (seen: Request[]) =>
  seen.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/receipts'));

async function openForm() {
  const app = show(partly());
  await heading();
  await app.user.click(screen.getByRole('button', { name: 'Record receipt' }));
  return { ...app, form: screen.getByRole('form', { name: 'Record receipt' }) };
}

describe('[FR-RCV-01] who is offered Record receipt', () => {
  it('[FR-RCV-01] the owner of an approved order with something outstanding, no one else', async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, boolean][] = [
      ['owner, partly received', partly(), OWNER, true],
      ['owner, nothing received', approvedOrder(), OWNER, true],
      [
        'owner, fully received',
        approvedOrder({
          lines: [orderLine({ receivedQuantity: 3 })],
          receiptProgress: 'FULLY_RECEIVED',
        }),
        OWNER,
        false,
      ],
      ['owner, draft', order(), OWNER, false],
      [
        'an Approver',
        partly(),
        { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] },
        false,
      ],
      [
        'another Buyer',
        partly(),
        { ...ME, id: '0192e4a0-0000-7000-8000-00000000bbbb', roles: ['BUYER'] },
        false,
      ],
    ];
    for (const [name, shown, user, offered] of cases) {
      show(shown, { user });
      await heading();
      expect(!!screen.queryByRole('button', { name: 'Record receipt' }), name).toBe(offered);
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});

describe('[FR-RCV-01] the receipt form', () => {
  it('[FR-RCV-01] one quantity per line still to come, labelled by line; the date today in India, between approval and today', async () => {
    const { form } = await openForm();
    const quantities = within(form).getAllByRole('spinbutton');
    expect(quantities).toHaveLength(1);
    expect(quantities[0]).toHaveAccessibleName(
      'Line 1, Washers: quantity received (60 outstanding)',
    );
    const date = within(form).getByLabelText('Receipt date');
    expect(date).toHaveValue(TODAY);
    expect(date).toHaveAttribute('min', '2026-11-18');
    expect(date).toHaveAttribute('max', TODAY);
    expect(within(form).getByLabelText('Note (optional)')).toHaveAttribute('maxlength', '500');
    expect(within(form).getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-RCV-01] the dialog says per line what the receipt does, warns of a full receipt, and focuses Go back', async () => {
    const { user, form } = await openForm();
    await user.type(within(form).getAllByRole('spinbutton')[0] as HTMLElement, '60');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Line 1: receiving 60, received so far 40, outstanding after 0',
    );
    expect(dialog).toHaveTextContent(
      "This marks line 1 as fully received. Receipts can't be changed or undone.",
    );
    expect(within(dialog).getByRole('button', { name: 'Go back' })).toHaveFocus();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-CON-01] confirming sends one request with an Idempotency-Key, then reloads and says so', async () => {
    const { user, form, seen } = await openForm();
    await user.type(within(form).getAllByRole('spinbutton')[0] as HTMLElement, '60');
    await user.type(within(form).getByLabelText('Note (optional)'), 'Second van');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Record receipt' }));
    expect(await screen.findByText('Receipt recorded.')).toHaveAttribute('role', 'status');
    const sent = posts(seen);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(await sent[0]?.clone().json()).toEqual({
      receivedOn: TODAY,
      note: 'Second van',
      lines: [{ lineId: orderLine().id, quantity: 60 }],
    });
    expect(screen.queryByRole('form', { name: 'Record receipt' })).not.toBeInTheDocument();
    const orderReads = seen.filter(
      (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith(ORDER_ID),
    );
    expect(orderReads.length).toBeGreaterThan(1);
  });

  it('[NFR-CON-01] a retry from the same dialog reuses its Idempotency-Key', async () => {
    let calls = 0;
    const app = show(partly(), {
      post: () => {
        calls += 1;
        return calls === 1 ? problem(503, 'SERVICE_UNAVAILABLE') : json(201, recorded);
      },
    });
    await heading();
    await app.user.click(screen.getByRole('button', { name: 'Record receipt' }));
    const form = screen.getByRole('form', { name: 'Record receipt' });
    await app.user.type(within(form).getAllByRole('spinbutton')[0] as HTMLElement, '5');
    await app.user.click(within(form).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('alertdialog');
    await app.user.click(within(dialog).getByRole('button', { name: 'Record receipt' }));
    await within(dialog).findByRole('alert');
    await app.user.click(within(dialog).getByRole('button', { name: 'Record receipt' }));
    await screen.findByText('Receipt recorded.');
    const keys = posts(app.seen).map((r) => r.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('[FR-RCV-02] an over-receipt is shown inside the dialog, every line named; Reload order; the inputs marked', async () => {
    const app = show(partly(), {
      post: () =>
        problem(409, 'RECEIPT_EXCEEDS_OUTSTANDING', {
          detail: 'Nothing was recorded. Line 1 has only 50 outstanding; you entered 60.',
          lines: [{ lineId: orderLine().id, position: 0, outstanding: 50, requested: 60 }],
        }),
    });
    await heading();
    await app.user.click(screen.getByRole('button', { name: 'Record receipt' }));
    const form = screen.getByRole('form', { name: 'Record receipt' });
    await app.user.type(within(form).getAllByRole('spinbutton')[0] as HTMLElement, '60');
    await app.user.click(within(form).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('alertdialog');
    await app.user.click(within(dialog).getByRole('button', { name: 'Record receipt' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was recorded.');
    expect(alert).toHaveTextContent('Line 1 has only 50 outstanding; you entered 60.');
    expect(within(dialog).getByRole('button', { name: 'Reload order' })).toBeInTheDocument();
    // The modal hides the form behind it from the accessibility tree while it is open.
    expect(within(form).getAllByRole('spinbutton', { hidden: true })[0]).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

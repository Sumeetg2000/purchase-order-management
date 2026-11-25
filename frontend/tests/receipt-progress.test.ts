import { describe, expect, it } from 'vitest';
import {
  OPEN_ORDERS_NEXT_STEPS,
  cancelledSummary,
  fullyReceivedWarning,
  lineReceivedText,
  openOrdersCounts,
  openOrdersNote,
  receiptBadge,
  receivedSummary,
} from '../src/pages/orders/receipt-progress';

// The receipt words, in one place (specs/007-goods-receipt/research.md R8, R12,
// contracts/ui.md): the received summary, the badges, the fully-received warning and the
// Admin's open-order counts.

describe('[FR-RCV-01] the received summary', () => {
  it('[FR-RCV-01] says complete and partly received lines out of all, leaving a zero part out', () => {
    expect(receivedSummary({ complete: 2, partly: 1, total: 5 })).toBe(
      '2 of 5 lines complete, 1 partly received',
    );
    expect(receivedSummary({ complete: 0, partly: 1, total: 5 })).toBe(
      '1 of 5 lines partly received',
    );
    expect(receivedSummary({ complete: 2, partly: 0, total: 5 })).toBe('2 of 5 lines complete');
    expect(receivedSummary({ complete: 0, partly: 0, total: 5 })).toBe('Nothing received');
    expect(receivedSummary({ complete: 1, partly: 0, total: 1 })).toBe('1 of 1 line complete');
  });

  it('[FR-LCK-02] a cancelled order prefixes its summary', () => {
    expect(cancelledSummary({ complete: 2, partly: 1, total: 5 })).toBe(
      'Cancelled · 2 of 5 lines complete, 1 partly received',
    );
    expect(cancelledSummary({ complete: 0, partly: 0, total: 5 })).toBe(
      'Cancelled · Nothing received',
    );
  });

  it('[FR-RCV-01] a line says how much of it was received', () => {
    expect(lineReceivedText(60, 100)).toBe('60 of 100 received');
  });
});

describe('[FR-RCV-01] receipt badges', () => {
  it('[FR-RCV-01] approved: partly or fully received; nothing when nothing is received', () => {
    expect(receiptBadge('APPROVED', 'PARTIALLY_RECEIVED')).toBe('Partly received');
    expect(receiptBadge('APPROVED', 'FULLY_RECEIVED')).toBe('Fully received');
    expect(receiptBadge('APPROVED', 'NOT_RECEIVED')).toBeUndefined();
  });

  it('[FR-LCK-02] cancelled with receipts: "Cancelled · partly received"; other statuses none', () => {
    expect(receiptBadge('CANCELLED', 'PARTIALLY_RECEIVED')).toBe('Cancelled · partly received');
    expect(receiptBadge('CANCELLED', 'NOT_RECEIVED')).toBeUndefined();
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'] as const) {
      expect(receiptBadge(status, 'NOT_RECEIVED'), status).toBeUndefined();
    }
  });
});

describe('[FR-RCV-01] the fully-received warning', () => {
  it('[FR-RCV-01] names the line by its number (position + 1) and says receipts are permanent', () => {
    expect(fullyReceivedWarning(0)).toBe(
      "This marks line 1 as fully received. Receipts can't be changed or undone.",
    );
    expect(fullyReceivedWarning(4)).toBe(
      "This marks line 5 as fully received. Receipts can't be changed or undone.",
    );
  });
});

describe("[FR-ACC-07] the Admin's open-order counts", () => {
  it('[FR-ACC-07] lists the three counts', () => {
    expect(openOrdersCounts({ draft: 2, pending: 1, approvedWithOpenLines: 2 })).toBe(
      '2 drafts · 1 pending · 2 approved with goods to receive',
    );
    expect(openOrdersCounts({ draft: 1, pending: 0, approvedWithOpenLines: 0 })).toBe(
      '1 draft · 0 pending · 0 approved with goods to receive',
    );
  });

  it('[FR-ACC-07] says what happens to them only when any is above zero', () => {
    expect(OPEN_ORDERS_NEXT_STEPS).toBe(
      'An Approver rejects their pending orders and cancels their approved ones; a buyer raises new orders if still needed.',
    );
    expect(openOrdersNote({ draft: 0, pending: 1, approvedWithOpenLines: 0 })).toBe(
      OPEN_ORDERS_NEXT_STEPS,
    );
    expect(openOrdersNote({ draft: 0, pending: 0, approvedWithOpenLines: 0 })).toBeUndefined();
  });
});

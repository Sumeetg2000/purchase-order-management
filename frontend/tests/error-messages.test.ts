import {
  ERROR_CODES,
  NOT_ORDER_OWNER_DETAIL,
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_APPROVER_READ_ONLY_MESSAGE,
  ORDER_DECISION_APPROVER_ONLY_MESSAGE,
  ORDER_LOCKED_MESSAGES,
  ORDER_OWNER_INACTIVE_DETAIL,
  ORDER_PENDING_APPROVAL_DETAIL,
  PUBLIC_REVOKE_REASONS,
  ORDER_CANCEL_APPROVER_ONLY_MESSAGE,
  SELF_APPROVAL_DETAIL,
  SELF_APPROVAL_DETAILS,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import {
  dateBeforeApprovalMessage,
  describeFailure,
  errorMessages,
  fieldMessages,
  messageForOrderAction,
  messageForProblem,
  revokeReasonText,
  sentenceFor,
} from '../src/errors/messages';

describe('[NFR-FE-01] web error messages', () => {
  it('[NFR-FE-01] every registry code has a non-empty message', () => {
    for (const code of ERROR_CODES)
      expect(errorMessages[code].message.length, code).toBeGreaterThan(0);
  });

  it('[FR-ACC-03] each failed one-time link says what happened', () => {
    // The next step is separate, so a page whose link follows can leave it out.
    expect(errorMessages.TOKEN_EXPIRED).toEqual({
      message: 'This link has expired.',
      action: 'Request a new one.',
    });
    expect(errorMessages.TOKEN_USED.message).toBe('This link has already been used.');
    expect(errorMessages.TOKEN_SUPERSEDED.message).toBe(
      'A newer link was sent. Use the latest email.',
    );
    expect(errorMessages.INVALID_TOKEN.message).toBe(
      "This link isn't valid. Check that you opened the whole link from the email.",
    );
  });
});

describe('[FR-VEN-01] vendor messages (specs/003-vendors/contracts/errors.md)', () => {
  it('[FR-VEN-01] each vendor code says what happened and what to do', () => {
    expect(sentenceFor({ code: 'DUPLICATE_VENDOR_NAME' })).toBe(
      'A vendor with this name already exists.',
    );
    expect(sentenceFor({ code: 'INVALID_STATE_TRANSITION' })).toBe(
      'Its status has already changed. Reload to see the current status.',
    );
    expect(sentenceFor({ code: 'VENDOR_INACTIVE' })).toBe(
      'This vendor is deactivated. Reactivate it or choose another vendor.',
    );
    expect(fieldMessages.VENDOR_NOT_FOUND).toBe('This vendor no longer exists.');
  });
});

describe('[FR-PO-01] order messages (specs/004-draft-orders/contracts/errors.md)', () => {
  it('[FR-PO-01] a reused idempotency key says to start a new order', () => {
    expect(sentenceFor({ code: 'IDEMPOTENCY_KEY_REUSED' })).toBe(
      'This request was already used for a different order. Start a new order.',
    );
  });

  it('[NFR-VAL-01] each order field code says what to fix', () => {
    expect(fieldMessages.LINE_NOT_FOUND).toBe('This line is no longer on the order. Reload it.');
    expect(fieldMessages.DUPLICATE_LINE_ID).toBe('This line appears twice. Reload the order.');
    expect(fieldMessages.READ_ONLY_FIELD).toBe(
      "This is calculated by the system and can't be set.",
    );
  });

  it('[NFR-AUTH-01] FORBIDDEN on an order action says why, by the caller role and the action', () => {
    const forbidden = { code: 'FORBIDDEN' };
    expect(messageForOrderAction(forbidden, { roles: ['ADMIN'], action: 'write' })).toEqual({
      message: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
    expect(messageForOrderAction(forbidden, { roles: ['APPROVER'], action: 'write' })).toEqual({
      message: ORDER_APPROVER_READ_ONLY_MESSAGE,
    });
    expect(messageForOrderAction(forbidden, { roles: ['BUYER'], action: 'decision' })).toEqual({
      message: ORDER_DECISION_APPROVER_ONLY_MESSAGE,
    });
    expect(messageForOrderAction(forbidden, { roles: ['ADMIN'], action: 'decision' })).toEqual({
      message: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
    // A Buyer refused a write (a role removed mid-session) gets the usual words.
    expect(messageForOrderAction(forbidden, { roles: ['BUYER'], action: 'write' })).toEqual(
      errorMessages.FORBIDDEN,
    );
    expect(
      messageForOrderAction({ code: 'VERSION_CONFLICT' }, { roles: ['ADMIN'], action: 'write' }),
    ).toEqual(errorMessages.VERSION_CONFLICT);
  });

  it('[NFR-AUTH-01] a refused receipt says why: an Approver gets its own words, an Admin the read-only ones', () => {
    const forbidden = { code: 'FORBIDDEN' };
    expect(messageForOrderAction(forbidden, { roles: ['APPROVER'], action: 'receipt' })).toEqual({
      message: "Approvers can't record receipts. The order's Buyer records them.",
    });
    expect(messageForOrderAction(forbidden, { roles: ['ADMIN'], action: 'receipt' })).toEqual({
      message: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
  });

  it('[FR-SOD-01] a refused cancel says why: Buyer, Admin, or the order is your own', () => {
    const forbidden = { code: 'FORBIDDEN' };
    expect(messageForOrderAction(forbidden, { roles: ['BUYER'], action: 'cancel' })).toEqual({
      message: ORDER_CANCEL_APPROVER_ONLY_MESSAGE,
    });
    expect(messageForOrderAction(forbidden, { roles: ['ADMIN'], action: 'cancel' })).toEqual({
      message: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
    expect(
      messageForOrderAction(
        { code: 'SELF_APPROVAL' },
        { roles: ['BUYER', 'APPROVER'], action: 'cancel' },
      ),
    ).toEqual({ message: SELF_APPROVAL_DETAILS.CANCEL });
    // Approve and reject keep their own words.
    expect(
      messageForOrderAction({ code: 'SELF_APPROVAL' }, { roles: ['APPROVER'], action: 'decision' }),
    ).toEqual({ message: SELF_APPROVAL_DETAIL });
    expect(
      messageForOrderAction(
        { code: 'INVALID_STATE_TRANSITION', orderState: { status: 'CANCELLED', action: 'CANCEL' } },
        { roles: ['APPROVER'], action: 'cancel' },
      ),
    ).toEqual(errorMessages.INVALID_STATE_TRANSITION);
  });
});

describe('[NFR-FE-02] logged-out messages', () => {
  it('[FR-LCK-01] a locked order says why, by its status', () => {
    expect(sentenceFor({ code: 'ORDER_LOCKED', orderState: { status: 'APPROVED' } })).toBe(
      ORDER_LOCKED_MESSAGES.APPROVED,
    );
    expect(
      sentenceFor({ code: 'ORDER_LOCKED', orderState: { status: 'REJECTED', action: 'EDIT' } }),
    ).toBe(ORDER_LOCKED_MESSAGES.REJECTED);
    // Slice 5: a cancelled order has its own sentence.
    expect(sentenceFor({ code: 'ORDER_LOCKED', orderState: { status: 'CANCELLED' } })).toBe(
      'This order was cancelled and is closed.',
    );
    // A status with no sentence (none today) keeps the neutral words.
    expect(sentenceFor({ code: 'ORDER_LOCKED', orderState: { status: 'DRAFT' } })).toBe(
      "This order can't be changed any more.",
    );
    expect(sentenceFor({ code: 'ORDER_LOCKED' })).toBe("This order can't be changed any more.");
  });

  it('[FR-APR-02] the slice 4 order codes use the API details word for word', () => {
    expect(sentenceFor({ code: 'ORDER_PENDING_APPROVAL' })).toBe(ORDER_PENDING_APPROVAL_DETAIL);
    expect(sentenceFor({ code: 'ORDER_OWNER_INACTIVE' })).toBe(ORDER_OWNER_INACTIVE_DETAIL);
    expect(sentenceFor({ code: 'NOT_ORDER_OWNER' })).toBe(NOT_ORDER_OWNER_DETAIL);
    expect(sentenceFor({ code: 'SELF_APPROVAL' })).toBe(SELF_APPROVAL_DETAIL);
  });

  it('[NFR-FE-02] every public revoke reason has its words', () => {
    for (const reason of PUBLIC_REVOKE_REASONS) {
      expect(revokeReasonText[reason].length, reason).toBeGreaterThan(0);
    }
  });

  it('[NFR-FE-02] SESSION_REVOKED with a public reason says why', () => {
    expect(messageForProblem({ code: 'SESSION_REVOKED', reason: 'PASSWORD_CHANGED' }).message).toBe(
      'You were logged out because your password was changed. Please log in again.',
    );
    expect(messageForProblem({ code: 'SESSION_REVOKED', reason: 'PASSWORD_RESET' }).message).toBe(
      'You were logged out because your password was reset. Please log in again.',
    );
    expect(messageForProblem({ code: 'SESSION_REVOKED', reason: 'ROLES_CHANGED' }).message).toBe(
      'You were logged out because your roles were changed. Please log in again.',
    );
  });

  it('[NFR-FE-02] SESSION_REVOKED without a reason, or with an unknown one, gives the generic message', () => {
    const generic = "You've been logged out. Please log in again.";
    expect(messageForProblem({ code: 'SESSION_REVOKED' }).message).toBe(generic);
    expect(messageForProblem({ code: 'SESSION_REVOKED', reason: 'LOGOUT' }).message).toBe(generic);
  });

  it('[NFR-FE-02] SESSION_EXPIRED keeps its own message', () => {
    expect(messageForProblem({ code: 'SESSION_EXPIRED' }).message).toBe(
      'Your session has expired. Please log in again.',
    );
  });

  it('[NFR-FE-02] other codes ignore a reason and use their own message', () => {
    expect(messageForProblem({ code: 'NOT_FOUND', reason: 'PASSWORD_CHANGED' })).toEqual(
      errorMessages.NOT_FOUND,
    );
  });
});

describe('[NFR-FE-01] messages that say exactly what happened', () => {
  it('[NFR-SEC-05] a locked account says it is locked, and how long to wait', () => {
    expect(sentenceFor({ code: 'ACCOUNT_LOCKED' })).toBe(
      'This account is locked after too many failed login attempts. Try again in a few minutes.',
    );
    expect(sentenceFor({ code: 'ACCOUNT_LOCKED' }, 601)).toBe(
      'This account is locked after too many failed login attempts. Try again in 11 minutes.',
    );
  });

  it("[NFR-SEC-05] a rate limit has its own words, not the lockout's", () => {
    expect(sentenceFor({ code: 'RATE_LIMITED' })).toBe(
      "You've made too many requests in a short time. Wait a few minutes, then try again.",
    );
    expect(sentenceFor({ code: 'RATE_LIMITED' }, 60)).toBe(
      "You've made too many requests in a short time. Try again in 1 minute.",
    );
  });

  it('[NFR-FE-02] an expired login says so', () => {
    expect(sentenceFor({ code: 'ACCESS_TOKEN_EXPIRED' })).toBe(
      'Your login has expired. Please log in again.',
    );
  });

  it('[NFR-FE-01] INVALID_STATE_TRANSITION names no entity, since orders reuse it', () => {
    expect(sentenceFor({ code: 'INVALID_STATE_TRANSITION' })).not.toMatch(/vendor/i);
  });
});

describe('[NFR-FE-01] validation failures with no highlighted field', () => {
  const failure = (details: { path: string; code: string }[]) => ({
    problem: { code: 'VALIDATION_FAILED', details },
  });

  it('[NFR-FE-01] says each field error at form level, with its label where the page gives one', () => {
    expect(
      describeFailure(
        failure([
          { path: 'body.email', code: 'INVALID_FORMAT' },
          { path: 'body.extra', code: 'UNKNOWN_FIELD' },
        ]),
        { labels: { 'body.email': 'Email' } },
      ),
    ).toEqual({
      message: `Some of the details are not valid. Email: ${fieldMessages.INVALID_FORMAT} ${fieldMessages.UNKNOWN_FIELD}`,
      action: 'Correct them and try again.',
    });
  });

  it('[NFR-FE-01] never mentions highlighted fields when none is highlighted', () => {
    expect(sentenceFor({ code: 'VALIDATION_FAILED' })).not.toMatch(/highlighted/);
    expect(describeFailure(failure([{ path: 'body.x', code: 'REQUIRED' }])).action).not.toMatch(
      /highlighted/,
    );
  });

  it('[NFR-FE-01] keeps "check the highlighted fields" when the page highlights them', () => {
    const both = failure([
      { path: 'body.name', code: 'REQUIRED' },
      { path: 'body.extra', code: 'UNKNOWN_FIELD' },
    ]);
    expect(describeFailure(both, { highlighted: ['body.name'] })).toEqual({
      message: `Some of the details are not valid. ${fieldMessages.UNKNOWN_FIELD}`,
      action: 'Check the highlighted fields and try again.',
    });
  });
});

describe('[FR-RCV-02] receipt messages (specs/007-goods-receipt/contracts/errors.md)', () => {
  it("[FR-SM-01] a receipt on an order that isn't approved names its status", () => {
    expect(sentenceFor({ code: 'ORDER_NOT_RECEIVABLE', orderState: { status: 'CANCELLED' } })).toBe(
      "This order can't receive goods: it is cancelled.",
    );
    expect(
      sentenceFor({ code: 'ORDER_NOT_RECEIVABLE', orderState: { status: 'PENDING_APPROVAL' } }),
    ).toBe("This order can't receive goods: it is pending approval.");
    expect(sentenceFor({ code: 'ORDER_NOT_RECEIVABLE', orderState: { status: 'DRAFT' } })).toBe(
      "This order can't receive goods: it is a draft.",
    );
    expect(sentenceFor({ code: 'ORDER_NOT_RECEIVABLE', orderState: { status: 'REJECTED' } })).toBe(
      "This order can't receive goods: it is rejected.",
    );
    expect(sentenceFor({ code: 'ORDER_NOT_RECEIVABLE' })).toBe(
      "This order can't receive goods. Reload the order to see its status.",
    );
  });

  it('[FR-RCV-02] an over-receipt says nothing was recorded, then one line per offending line', () => {
    expect(
      sentenceFor({
        code: 'RECEIPT_EXCEEDS_OUTSTANDING',
        lines: [
          { lineId: 'b', position: 1, outstanding: 5, requested: 6 },
          { lineId: 'c', position: 2, outstanding: 0, requested: 1 },
        ],
      }),
    ).toBe(
      'Nothing was recorded. Line 2 has only 5 outstanding; you entered 6. Line 3 has only 0 outstanding; you entered 1.',
    );
    // The first line is line 1, never line 0.
    expect(
      sentenceFor({
        code: 'RECEIPT_EXCEEDS_OUTSTANDING',
        lines: [{ lineId: 'a', position: 0, outstanding: 2, requested: 3 }],
      }),
    ).toBe('Nothing was recorded. Line 1 has only 2 outstanding; you entered 3.');
    expect(sentenceFor({ code: 'RECEIPT_EXCEEDS_OUTSTANDING' })).toBe(
      'Nothing was recorded. Reload the order to see what is outstanding.',
    );
  });

  it('[FR-LCK-02] a fully received order says why it cannot be cancelled', () => {
    expect(sentenceFor({ code: 'ORDER_FULLY_RECEIVED' })).toBe(
      "This order has been fully received, so it can't be cancelled.",
    );
  });

  it('[NFR-VAL-01] the receipt date field codes say what to enter', () => {
    expect(fieldMessages.DATE_IN_FUTURE).toBe("Enter today's date or an earlier one.");
    expect(fieldMessages.DATE_BEFORE_APPROVAL).toBe(
      "Enter a date on or after the order's approval.",
    );
    expect(dateBeforeApprovalMessage('24 Nov 2026')).toBe(
      "Enter a date on or after the order's approval (24 Nov 2026).",
    );
  });
});

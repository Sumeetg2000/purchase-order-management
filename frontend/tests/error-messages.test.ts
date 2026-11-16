import { ERROR_CODES, ORDER_ADMIN_READ_ONLY_MESSAGE, PUBLIC_REVOKE_REASONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  errorMessages,
  fieldMessages,
  messageForOrderWrite,
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

  it('[NFR-AUTH-01] FORBIDDEN on an order write tells an Admin why, and anyone else the usual words', () => {
    expect(messageForOrderWrite({ code: 'FORBIDDEN' }, { isAdmin: true })).toEqual({
      message: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
    expect(messageForOrderWrite({ code: 'FORBIDDEN' }, { isAdmin: false })).toEqual(
      errorMessages.FORBIDDEN,
    );
    expect(messageForOrderWrite({ code: 'VERSION_CONFLICT' }, { isAdmin: true })).toEqual(
      errorMessages.VERSION_CONFLICT,
    );
  });
});

describe('[NFR-FE-02] logged-out messages', () => {
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

import { ERROR_CODES, PUBLIC_REVOKE_REASONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { errorMessages, messageForProblem, revokeReasonText } from '../src/errors/messages';

describe('[NFR-FE-01] web error messages', () => {
  it('[NFR-FE-01] every registry code has a non-empty message', () => {
    for (const code of ERROR_CODES)
      expect(errorMessages[code].message.length, code).toBeGreaterThan(0);
  });

  it('[FR-ACC-03] each failed one-time link says what happened', () => {
    expect(errorMessages.TOKEN_EXPIRED.message).toBe('This link has expired. Request a new one.');
    expect(errorMessages.TOKEN_USED.message).toBe('This link has already been used.');
    expect(errorMessages.TOKEN_SUPERSEDED.message).toBe(
      'A newer link was sent. Use the latest email.',
    );
    expect(errorMessages.INVALID_TOKEN.message).toBe(
      "This link isn't valid. Check that you opened the whole link from the email.",
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

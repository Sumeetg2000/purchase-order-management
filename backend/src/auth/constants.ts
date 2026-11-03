import { PUBLIC_REVOKE_REASONS } from '@po/contracts';

// Authentication and session numbers (ADR-0017). The sessions table's CHECKs (migration
// 0008_sessions) and the users lockout CHECK (0007_user_accounts) hold copies of some of
// them; tests/integration/accounts-schema.test.ts pins each copy.

/**
 * Every reason a session can be revoked for, as stored in sessions.revoke_reason and the
 * security log. Only the public ones (from @po/contracts) ever reach the user.
 */
export const SESSION_REVOKE_REASONS = [
  ...PUBLIC_REVOKE_REASONS,
  'DEACTIVATED',
  'LOGOUT',
  'LOGOUT_ALL',
  'USER_REVOKED',
  'REUSE_DETECTED',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/** Consecutive wrong passwords that lock an account (ADR-0017). */
export const LOCKOUT_THRESHOLD = 5;

/** The longest user agent kept for a session; longer ones are truncated. */
export const USER_AGENT_MAX_LENGTH = 512;

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * MINUTE_SECONDS;

/** How long an access token (and its cookie) is valid. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * MINUTE_SECONDS;

/** How long a refresh token is valid: a session unused this long ends. */
export const REFRESH_TOKEN_IDLE_SECONDS = 7 * DAY_SECONDS;

/** A session ends this long after login, however active; rotation never extends it. */
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = 30 * DAY_SECONDS;

/** A rotated refresh token presented within this window gets a sibling, not revocation. */
export const REFRESH_SIBLING_GRACE_SECONDS = 10;

/** How long a locked account stays locked. */
export const LOCKOUT_DURATION_SECONDS = 15 * MINUTE_SECONDS;

/** Random bytes in a refresh token (256 bits). */
export const REFRESH_TOKEN_BYTES = 32;

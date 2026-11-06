// Why a session was revoked, as far as the user is told (ADR-0017, amended 2026-11-03).
// SESSION_REVOKED carries one of these as the problem's `reason`; every other revocation
// leaves `reason` out. The backend's full list of revoke reasons is built from this one.

export const PUBLIC_REVOKE_REASONS = [
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'ROLES_CHANGED',
] as const;
export type PublicRevokeReason = (typeof PUBLIC_REVOKE_REASONS)[number];

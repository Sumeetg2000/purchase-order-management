// Who an audit entry names as its actor (ADR-0016): a user, the system (bootstrap, seed,
// jobs) or an operator at the CLI. The audit_entries CHECK allows exactly these.
export const AUDIT_ACTOR_TYPES = ['USER', 'SYSTEM', 'OPERATOR'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

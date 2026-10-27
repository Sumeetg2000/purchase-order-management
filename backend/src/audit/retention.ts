/**
 * How long audit entries are kept (ADR-0020). The audit_retention_guard trigger
 * (migration 0003_audit) refuses deleting a younger entry, and the maintenance purge
 * removes older ones; a test checks the trigger uses this same period.
 */
export const AUDIT_RETENTION_YEARS = 8;

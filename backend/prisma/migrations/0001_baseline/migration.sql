-- Baseline privileges (ADR-0003). Each later migration grants exactly what its tables
-- need; nothing is granted by default.
GRANT USAGE ON SCHEMA public TO po_app, po_maintenance;

-- Readiness (po_app) checks that no migration is pending or failed.
GRANT SELECT ON TABLE _prisma_migrations TO po_app;

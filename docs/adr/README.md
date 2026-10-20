# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-order-lifecycle-and-numbering.md) | Order lifecycle, state table and FY PO numbering | Accepted |
| [0002](0002-approval-policy-and-chain.md) | Approval threshold, data-driven chain, single-tier seed | Accepted (approval levels: not adopted) |
| [0003](0003-derived-values-strategy.md) | Derived values: stored and trigger-maintained | Accepted |
| [0004](0004-ownership-visibility-and-sod.md) | Private orders, visibility, separation of duties, authorization matrix | Accepted (authority levels and owner transfer: not adopted) |
| [0005](0005-vendors.md) | Shared vendor list, uniqueness, snapshot, deactivation | Accepted |
| [0006](0006-concurrency-and-transactions.md) | Concurrency and transaction strategy | Accepted |
| [0007](0007-api-conventions.md) | API conventions: pagination, errors, status codes | Accepted |
| [0008](0008-contract-source-of-truth.md) | Zod-first contract, generated OpenAPI | Accepted |
| [0009](0009-line-identity-on-edit.md) | Line identity on draft edits | Accepted |
| [0010](0010-money-currency-and-tax.md) | Money precision, currency and tax | Accepted |
| [0011](0011-cancellation-and-receipts.md) | Goods receipts and cancellation | Accepted (receipt corrections: not adopted) |
| [0012](0012-performance-targets-and-datasets.md) | Performance targets, datasets, load tests | Accepted |
| [0013](0013-traceability-and-test-naming.md) | Traceability, test naming, walkthrough answers | Accepted |
| [0014](0014-recording-deviations.md) | Recording deviations | Accepted |
| [0015](0015-outstanding-report.md) | Outstanding orders report | Accepted |
| [0016](0016-users-and-audit-trail.md) | Users, user management and audit trail | Accepted (Admin user management: signed off 2026-10-20) |
| [0017](0017-authentication-and-sessions.md) | Authentication, accounts, sessions and CSRF | Accepted |
| [0018](0018-production-frontend.md) | Production-grade frontend | Accepted (component library: slice-0 plan) |
| [0019](0019-considered-and-deferred-features.md) | Features considered, deferred or not adopted | Accepted |
| [0020](0020-stack-operations-and-retention.md) | Stack, operations, security baseline, retention | Accepted |

## Open deviations

| ADR | Principle / rule | Revisit condition |
|---|---|---|
| — | none | — |

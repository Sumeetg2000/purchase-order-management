# ADR-0019: Features considered, deferred or not adopted

- **Status:** Accepted · 2026-10-20 · amended 2026-10-20 (order-splitting control, receipt
  corrections, owner transfer and approval levels not adopted; MFA/SSO deferred; the
  constitution's out-of-scope list moved here)
- **Brief:** §8 ("Don't add new features — deepen what's here")
- **Principles:** X, XII

## Context
Reviews keep raising features a real procurement system would have. §8 asks us to deepen
what the brief describes, not to add features. Each item below was considered and
deliberately left out, so that a later request starts from a recorded reason rather than
from scratch. Adding any of them requires a new ADR. Anything that changes a role's
permissions also requires sign-off (Principle X).

## Decision

### Not adopted (owner decisions, 2026-10-20)
| Item | Reason | Revisit / consequence |
|---|---|---|
| **Order-splitting control** (routing a buyer's orders to approval when several to one vendor add up past the threshold) | Buyers legitimately split orders to get better vendor offers per order value. A blocking rule would punish normal buying. | Revisit if splitting fraud is observed. Detection would then be a **report** (for example orders per buyer and vendor within N days that together exceed the threshold), not a blocking rule. |
| **Receipt corrections** (reversal or negative receipt) | Keeps receipts strictly append-only and the outstanding guarantee simple. | **A mistyped receipt is permanent.** If it fully receives a line, the order can become fully received and can then no longer be cancelled (`409 ORDER_FULLY_RECEIVED`). Mitigation: the receipt confirmation dialog shows received-so-far and outstanding-after per line, and warns when a line becomes fully received (ADR-0011, ADR-0018). |
| **Owner transfer / reassignment** of orders | Buyers clear their backlog before leaving. | Anything left open: the Approver rejects pending orders and cancels approved ones, and a new order is raised (ADR-0004). The vendor then gets a new PO number. |
| **Approval authority levels** | One Approver and one tier today (ADR-0002). | Revisit with a second tier or a second Approver. |
| **Multi-tenancy (`org_id`)** | One organisation per deployment (ADR-0016). Every table, index, query, uniqueness rule and test would carry a tenant key, for no requirement in the brief. Restricted signup (ADR-0017) keeps outsiders out. | — |

### Considered, deferred
| Feature | Why deferred | What it would need |
|---|---|---|
| Approver delegation / out-of-office | Changes who may approve which order, which is an actor and permission change (Principle X). With one Approver, an absence stalls orders above ₹1,00,000 (ADR-0002). | Sign-off; a delegation model (who, for how long, with which limits); separation-of-duties rules for the delegate; audit events |
| Email notifications (submitted, approved, rejected, cancelled, access requested) | A notification must not be lost when the send fails, or sent for a rolled-back change. That needs a transactional outbox and a worker, which is a new moving part (Principle XII). Auth emails are sent after commit without an outbox, because the user can retry them (ADR-0017). Access requests are in-app only (ADR-0016). | An outbox table written in the business transaction; a worker with retries and idempotency; user preferences |
| MFA / SSO | Setup cost: an identity provider integration, enrolment and recovery flows. | OIDC/SAML against the company's identity provider, or TOTP for Admin at minimum when added |
| Attachments (quotes, invoices on an order) | Needs file storage, size and type limits, malware scanning, and access control that follows order visibility. | Object storage service, scanning, an ADR for retention |
| Vendor-facing PO PDF | Needs a document template, legal fields (GSTIN, addresses, terms) the data model doesn't have, and a rendering dependency. | PDF renderer, legal fields, template versioning |
| CSV export | Unbounded exports conflict with the "never load everything" rule (Principle VII) unless streamed and limited. Lists and the report are already paginated and filterable. | A streamed, row-limited export per list, with the same scoping and an audit event |
| Delivery date and delivery address on orders | New order fields with validation and display rules that the brief doesn't mention. They'd also need to go into the vendor snapshot and the lock rules. | Fields, lock and snapshot rules, report filters |

### Out of scope (from the brief's boundaries)
- multi-currency (one currency per deployment, ADR-0010)
- tax (GST): amounts are pre-tax (ADR-0010)
- close-short: cancelling a partly received order serves the purpose (ADR-0011)
- copy-order
- budget checks
- invoices and three-way match

## Consequences
- Principle XII points here for everything out of scope.
- Adding any of these requires a new ADR. A change to a role's permissions also requires
  sign-off.

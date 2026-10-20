# ADR-0014: Recording deviations from the constitution

- **Status:** Accepted · 2026-10-16
- **Gap:** G17
- **Principles:** Governance

## Decision
- Every deviation is recorded as a plan Complexity Tracking row **linked to** an ADR with
  status `Accepted (deviation)`. The ADR gives the principle and rule, the scope, the
  reason, the rejected alternative, and a **revisit condition**.
- `docs/adr/README.md` lists open deviations with their conditions.
- Every slice's review gate goes through the open deviations and closes or re-justifies any
  whose condition has been met.
- Principles I and VIII can never be deviated from.

## Why
A deviation recorded only in one slice's plan is forgotten once that slice is done. The
revisit condition, checked at every gate, stops "temporary" from becoming permanent.

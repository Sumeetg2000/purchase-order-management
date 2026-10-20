# ADR-0010: Money precision, currency and tax

- **Status:** Accepted · 2026-10-16
- **Brief:** §1, §3.3 · Gap G15, Q8
- **Principles:** I, XII

## Decision
- Exact to 4 decimal places, never rounded. `unit_price NUMERIC(13,4)`; `line_total` and
  `total` `NUMERIC(22,4)`, so the largest legal order (500 × 1,000,000 × 999,999,999.9999)
  doesn't overflow. Quantities are whole units.
- JSON uses decimal strings. TypeScript uses a decimal library, never `number`.
- One currency per deployment, configurable, defaulting to INR. The UI formats the decimal
  string with `Intl.NumberFormat('en-IN', { style: 'currency', currency,
  minimumFractionDigits: 2, maximumFractionDigits: 4 })`, giving lakh/crore grouping.
- **GST is out of scope.** Amounts are pre-tax, and the total is Σ quantity × unit price.
  Reason: §3.3 defines the total without tax, and tax belongs to invoicing.

## Alternatives
`NUMERIC(14,2)` (can't express sub-cent unit prices); rounding each line to cents
(reinterprets §3.3).

## Tests
0.1 × 3 = 0.3000; 7 × 0.0125 = 0.0875; 500 fractional lines exact in DB, TypeScript and
API; values at the limits; `"12345678.0125"` → `₹1,23,45,678.0125`.

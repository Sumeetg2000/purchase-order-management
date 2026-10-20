# Vendor & Purchase Order Management — Requirements

**Stack:** Express or Next.js (engineer's choice) · PostgreSQL · Prisma

## 1. Background

Purchase orders get raised in spreadsheets with no numbering discipline. Totals disagree with
their own line items, approved orders get quietly edited after the fact, and nobody can say
with confidence what's still outstanding against a given vendor.

You're building the system that fixes this: a vendor list with contact and payment terms,
purchase orders raised with line items whose total is always derived, an approval gate above a
threshold amount, and goods receipt tracked against each order — including partial receipts —
so outstanding orders by vendor and age are a real, trustworthy view.

This system's centre of gravity is **derived-value integrity under editing** — an order total or
outstanding quantity that can drift from the numbers it's supposed to be computed from is a
real failure here even if the happy path demos perfectly.

## 2. Actors

| Role | Can do |
| --- | --- |
| **Buyer** | Maintain vendors, raise purchase orders with line items, record goods received |
| **Approver** | Approve orders above the threshold amount, cancel an approved order with a reason |
| **Procurement Admin** | View outstanding orders by vendor and age across the organisation |

## 3. Functional requirements

### 3.1 Vendor management

- Maintain a vendor list with contact details and payment terms (e.g. net 30).
- A purchase order must reference a real vendor; you cannot raise an order against a vendor
that doesn't exist or has been deactivated.

### 3.2 Raising a purchase order

- An order has one or more line items (item description, quantity, unit price).
- An order starts in a draft or pending-approval state depending on its total — document which.

### 3.3 The order total is derived

- **The order total is always derived from its lines and must never be independently
editable.** This is the core hard case of this system: no code path — including a direct API
call — should be able to leave an order with a total that disagrees with the sum of
`quantity × unit price` across its lines.

### 3.4 Approval above a threshold

- Orders above a threshold amount require approval before they can proceed to goods receipt;
orders below it may auto-approve or require a lighter check — your choice, document it.
- Decide, and document, what happens if a line item is added or changed while the order is
mid-approval and the total consequently crosses the threshold.

### 3.5 Approved orders are locked

- Once approved, an order cannot be edited — not its lines, not its total, not its vendor.
- The only action available on an approved order is cancellation, which requires a reason and
is recorded distinctly from a draft edit.

### 3.6 Goods receipt

- Goods received against an order are recorded per line item, and receipts can be partial —
fewer units than ordered, across one or more separate receipt events.
- The outstanding quantity per line must always be derivable from the order quantity and the
sum of receipts against it, and a receipt that would push the received total above the
ordered quantity must be rejected.

### 3.7 Outstanding orders by vendor and age

- A view showing outstanding orders (not yet fully received) grouped or filterable by vendor,
with an age (time since raised or since approval).
- This is a real query, ready to explain its cost as orders accumulate over months.

## 4. Data to think through

You choose the exact schema. At minimum, your model needs to represent: vendors, purchase
orders and their status, the line items belonging to each order, and goods receipt events
recorded against specific lines over time — not just a single "received" flag per order.

The question worth sitting with before you write any code: is the order total (and the
outstanding quantity per line) something you calculate whenever it's needed, or something you
store and keep in sync as lines and receipts change? Both are legitimate designs. Pick one, and
be ready to show — under a direct API call that tries to bypass it — that it cannot drift out
of sync with the underlying lines and receipts.

## 5. How it's exposed

Design the API surface — routes, methods, request/response shapes — however fits the workflow
above. There's no prescribed structure here; the requirements in §3 are the spec, not a
particular set of endpoints.

## 6. Things this system will specifically be checked for

- Bad input — a line item with a negative quantity or price, an order referencing a vendor
that doesn't exist — should be rejected before it reaches your business logic.
- Every action — raising an order, approving it, recording a receipt — is tied to a real,
authenticated user; there's no anonymous path through this system.
- Trying to edit an already-approved order, directly via the API, must come back as a clear,
specific failure — not a silent no-op and not a generic error. Prove this with a test, not a
UI check.
- This is the sharpest test in this system: write a test that attempts, through every code path
you can think of, to leave an order's total mismatched with its lines, or a line's outstanding
quantity mismatched with its receipts, and confirm none of them succeed.
- Outstanding orders by vendor and age, and any list of orders, need to support filtering
without loading every order and every line into memory.
- Raising an order, each approval decision, and each goods receipt event should leave a
structured trace — the record procurement will actually ask for when an order is disputed.
- The whole thing should come up with `docker compose up` and no manual setup beyond a
documented `.env`.

## 7. Walkthrough questions to expect

NOTE: These are indicative questions only. Expect to be asked further questions in a similar
spirit during the walkthrough.

1. An approved order cannot be edited. Where is that enforced?
2. Show me a partial goods receipt. How is the outstanding quantity calculated?
3. How do you list outstanding orders by vendor and age? What does that query touch?

## 8. Additional requirements

Don't add new features — deepen what's here:

- Write a load test that raises 10,000 orders across 200 vendors with varying receipt histories
and show the query plan for outstanding-orders-by-age.
- Add a second approval tier for orders above a much higher threshold and show the routing
handles a variable-length approval chain without special-casing.
- Simulate two receipt events arriving for the same order line at almost the same instant and
show the outstanding-quantity guarantee still holds — the same mechanism that protects the
derived total, stressed from a different angle.

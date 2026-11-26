# UI contract: Slice 7 — Outstanding orders report

ADR-0018 rules: loading, empty and error states; errors by `code`; dates in India time;
axe clean. No dialog (the report changes nothing).

## Navigation

- Main nav item **Outstanding**, shown when `useCan('listOutstandingOrders')` (Buyer,
  Approver, Admin). Route `/reports/outstanding` (lazy page), guarded by
  `<RequireRole operation="listOutstandingOrders" />`.
- Two views on the page, as links styled as tabs: **Orders** (`/reports/outstanding`) and
  **By vendor** (`/reports/outstanding/vendors`).

## Orders view

- Heading "Outstanding orders"; under it "Ages as of {d MMMM yyyy} (India time)" from
  `asOf`. A Buyer-only caller sees "Your orders" in the subheading.
- Filters in the URL (`useListParams`): **Vendor** (the vendor combobox, inactive vendors
  included and marked), **Age** (select: All ages, 0–30 days, 31–60 days, 61–90 days,
  Over 90 days); Clear filters. A link with an invalid value shows the list's "This link
  has a filter we don't recognise" state, as the order list does.
- Table "Outstanding orders": PO number (link to the order), Vendor (name, "inactive" if
  so), Owner, Approved (date), Age ("{n} days"; "today" for 0), Age band, Open lines
  ("{open} of {count}"), Outstanding (units), and a **Show lines** toggle per row (a
  disclosure button with `aria-expanded`). Expanding fetches the order with the existing
  `GET /orders/{id}` (its own loading and error state inside the row) and shows a nested
  table of its lines: Line {position + 1}, Description, Ordered, Received, Outstanding,
  open lines first.
- Pagination as the order list; "{total} outstanding orders".
- Empty: "Nothing is outstanding." (no filters) or "No outstanding orders match these
  filters." with Clear filters.

## By vendor view

- Same heading and as-of line.
- Table "Outstanding orders by vendor": Vendor (link to the Orders view filtered to it),
  Orders, 0–30 days, 31–60 days, 61–90 days, Over 90 days, Oldest approval (date).
- Pagination; empty: "Nothing is outstanding."

## Words (one place: `frontend/src/pages/reports/report-words.ts`)

Bucket labels by `AgeBucket` (a `Record<AgeBucket, string>`, so a new bucket fails the
type check), age text, the as-of line, empty states.

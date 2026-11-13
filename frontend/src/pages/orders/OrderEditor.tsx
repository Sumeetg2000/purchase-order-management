import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  Button,
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import { Link, useNavigate, useParams } from 'react-router';
import { isFieldCode } from '@po/contracts';
import { newIdempotencyKey } from '../../api/idempotency-key';
import { failureMessage, type ApiFailure } from '../../api/submit';
import { SEARCH_DEBOUNCE_MS } from '../../components/SearchField';
import { fieldMessageFor } from '../../errors/messages';
import { useApiForm } from '../../hooks/useApiForm';
import { useQueryStates } from '../../hooks/useQueryStates';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import {
  lineBodyOf,
  lineErrors,
  lineTotalOf,
  orderTotalOf,
  rupees,
  type LineDraft,
  type LineErrors,
  type LineField,
} from './lines';
import {
  createOrder,
  editOrder,
  useActiveVendors,
  useOrder,
  useOrderSaved,
  type CreateOrderBody,
  type EditOrderBody,
  type Order,
} from './queries';

type OrderBody = CreateOrderBody | EditOrderBody;
import css from './orders.module.css';

const styles = classes(
  css,
  'editor',
  'vendor',
  'vendorControl',
  'popover',
  'option',
  'hint',
  'scroller',
  'lines',
  'number',
  'cellInput',
  'cellError',
  'rowActions',
  'total',
  'alert',
  'actions',
  'srOnly',
);
const controls = classes(controlsCss, 'button', 'primary');

/** Estimated row height for the virtual line table; rows are measured once rendered. */
const ROW_HEIGHT_PX = 56;
/** Rows rendered beyond the visible ones, so keyboard movement finds its neighbours. */
const OVERSCAN_ROWS = 8;

const FIELDS: readonly { field: LineField; label: string; inputMode?: 'numeric' | 'decimal' }[] = [
  { field: 'description', label: 'Description' },
  { field: 'quantity', label: 'Quantity', inputMode: 'numeric' },
  { field: 'unitPrice', label: 'Unit price', inputMode: 'decimal' },
];

interface Vendor {
  id: string;
  name: string;
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return debounced;
}

/** The API's own field errors for one line, from a failure's `body.lines.N.field` paths. */
function serverLineErrors(failure: ApiFailure | undefined, index: number): LineErrors {
  const errors: LineErrors = {};
  for (const detail of failure?.problem.details ?? []) {
    const [, , at, field] = detail.path.split('.');
    const isLineField = field === 'description' || field === 'quantity' || field === 'unitPrice';
    if (at === String(index) && isLineField && isFieldCode(detail.code)) {
      errors[field] ??= detail.code;
    }
  }
  return errors;
}

/** What the form starts from: nothing for a new order, the stored order for an edit. */
interface OrderFormStart {
  vendor?: Vendor | undefined;
  lines: readonly Omit<LineDraft, 'key'>[];
}

interface OrderFormProps {
  heading: string;
  submitLabel: string;
  start: OrderFormStart;
  /** Where Cancel goes. */
  cancelTo: string;
  send: (body: OrderBody) => Promise<{ data?: Order; error?: unknown; response: Response }>;
  /** Starts again from the stored order after a version conflict; edit only. */
  reload?: () => void;
}

/** What a form holds that a save would send, to tell whether there are unsaved edits. */
function signatureOf(vendor: Vendor | undefined, lines: readonly Omit<LineDraft, 'key'>[]) {
  return JSON.stringify([
    vendor?.id,
    lines.map(({ id, description, quantity, unitPrice }) => [id, description, quantity, unitPrice]),
  ]);
}

/**
 * The order form for both raising and editing a draft (contracts/ui.md): a vendor picker
 * over active vendors, a virtualised line table with row-level validation and live exact
 * totals, one request at a time, the unsaved-changes guard, and for an edit the version
 * conflict's Reload order. Saves with no dialog: a save is reversible.
 */
function OrderForm({ heading, submitLabel, start, cancelTo, send, reload }: OrderFormProps) {
  const navigate = useNavigate();
  const saved = useOrderSaved();
  const form = useApiForm();
  const nextKey = useRef(1);
  const newLine = (
    from: Omit<LineDraft, 'key'> = { description: '', quantity: '', unitPrice: '' },
  ): LineDraft => ({
    key: nextKey.current++,
    ...from,
  });
  const [lines, setLines] = useState<LineDraft[]>(() =>
    start.lines.length > 0 ? start.lines.map((line) => newLine(line)) : [newLine()],
  );
  const [vendor, setVendor] = useState<Vendor | undefined>(start.vendor);
  const [search, setSearch] = useState(start.vendor?.name ?? '');
  const [inactiveVendor, setInactiveVendor] = useState<string>();
  const vendorInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const q = useDebounced(search, SEARCH_DEBOUNCE_MS).trim();
  const vendors = useActiveVendors(q === '' ? undefined : q);
  const [startedFrom] = useState(() =>
    signatureOf(
      start.vendor,
      start.lines.length > 0 ? start.lines : [{ description: '', quantity: '', unitPrice: '' }],
    ),
  );
  const guard = useUnsavedChangesGuard(signatureOf(vendor, lines) !== startedFrom);

  // TanStack Virtual (ADR-0018) returns functions React Compiler can't memoize, so this
  // component isn't compiled; it re-renders on edits anyway.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

  const errors = lines.map(lineErrors);
  const valid = vendor !== undefined && errors.every((e) => Object.keys(e).length === 0);

  function edit(index: number, field: LineField, value: string) {
    setLines((current) => current.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
    form.clearFailure();
  }

  function move(index: number, by: -1 | 1) {
    setLines((current) => {
      const next = [...current];
      const [line] = next.splice(index, 1);
      if (line) next.splice(index + by, 0, line);
      return next;
    });
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!vendor || !valid) return;
    setInactiveVendor(undefined);
    const body = { vendorId: vendor.id, lines: lines.map(lineBodyOf) } as OrderBody;
    const outcome = await form.send(() => send(body));
    if (!outcome) return;
    if (!outcome.ok) {
      if (outcome.problem.code === 'VENDOR_INACTIVE') {
        setInactiveVendor(vendor.name);
        vendorInput.current?.focus();
      }
      return;
    }
    guard.release();
    saved(outcome.data);
    void navigate(`/orders/${outcome.data.id}`);
  }

  const conflict = form.failure?.problem.code === 'VERSION_CONFLICT';
  const failure =
    form.failure && !conflict && form.failure.problem.code !== 'VENDOR_INACTIVE'
      ? failureMessage(form.failure, {
          highlighted: (form.failure.problem.details ?? [])
            .map((d) => d.path)
            .filter((p) => /^body\.lines\.\d+\.(description|quantity|unitPrice)$/.test(p)),
          labels: { 'body.vendorId': 'Vendor', 'body.lines': 'Lines' },
        })
      : undefined;
  const items = vendors.data?.items ?? [];
  const rows = virtualizer.getVirtualItems();
  const padTop = rows[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (rows.at(-1)?.end ?? 0);

  return (
    <>
      <title>{`${heading} · Purchase Orders`}</title>
      <h1>{heading}</h1>
      <form className={styles.editor} onSubmit={(event) => void save(event)}>
        <ComboBox
          className={styles.vendor}
          inputValue={search}
          onInputChange={(value) => {
            setSearch(value);
            if (value !== vendor?.name) setVendor(undefined);
          }}
          value={vendor?.id ?? null}
          onChange={(id) => {
            const picked = items.find((v) => v.id === id);
            if (picked) {
              setVendor({ id: picked.id, name: picked.name });
              setSearch(picked.name);
              setInactiveVendor(undefined);
              form.clearFailure();
            }
          }}
          items={items}
          allowsEmptyCollection
          isRequired
        >
          <Label>Vendor</Label>
          <div className={styles.vendorControl}>
            <Input ref={vendorInput} />
            <Button aria-label="Show vendors">▾</Button>
          </div>
          <Popover className={styles.popover}>
            <ListBox
              renderEmptyState={() =>
                vendors.isError ? null : <p className={styles.hint}>No active vendor matches.</p>
              }
            >
              {(item: Vendor) => (
                <ListBoxItem className={styles.option} id={item.id} textValue={item.name}>
                  {item.name}
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
          {vendors.isError && (
            <p role="status" className={styles.hint}>
              Couldn&apos;t load vendors. Try again.
            </p>
          )}
        </ComboBox>

        <div ref={scroller} className={styles.scroller}>
          <table className={styles.lines} aria-label="Lines" aria-rowcount={lines.length + 1}>
            <thead>
              <tr aria-rowindex={1}>
                <th scope="col">#</th>
                <th scope="col">Description</th>
                <th scope="col">Quantity</th>
                <th scope="col">Unit price</th>
                <th scope="col">Line total</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={6} style={{ height: padTop }} />
                </tr>
              )}
              {rows.map((row) => {
                const index = row.index;
                const line = lines[index];
                if (!line) return null;
                const number = index + 1;
                const shown = { ...lineErrors(line), ...serverLineErrors(form.failure, index) };
                return (
                  <tr
                    key={line.key}
                    ref={virtualizer.measureElement}
                    data-index={index}
                    aria-rowindex={number + 1}
                  >
                    <td className={styles.number}>{number}</td>
                    {FIELDS.map(({ field, label, inputMode }) => {
                      // A field says its error once it holds something (or the API named it).
                      const code =
                        line[field] === '' && !serverLineErrors(form.failure, index)[field]
                          ? undefined
                          : shown[field];
                      const errorId = `line-${String(line.key)}-${field}-error`;
                      return (
                        <td key={field}>
                          <input
                            className={styles.cellInput}
                            aria-label={`${label}, line ${String(number)}`}
                            value={line[field]}
                            inputMode={inputMode}
                            autoComplete="off"
                            aria-invalid={code !== undefined}
                            {...(code === undefined ? {} : { 'aria-describedby': errorId })}
                            onChange={(event) => {
                              edit(index, field, event.target.value);
                            }}
                          />
                          {code !== undefined && (
                            <span id={errorId} className={styles.cellError}>
                              {fieldMessageFor(code)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className={styles.number} data-testid={`line-total-${String(number)}`}>
                      {rupees(lineTotalOf(line))}
                    </td>
                    <td className={styles.rowActions}>
                      <button
                        type="button"
                        className={controls.button}
                        aria-label={`Move line ${String(number)} up`}
                        disabled={index === 0}
                        onClick={() => {
                          move(index, -1);
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={controls.button}
                        aria-label={`Move line ${String(number)} down`}
                        disabled={index === lines.length - 1}
                        onClick={() => {
                          move(index, 1);
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={controls.button}
                        aria-label={`Remove line ${String(number)}`}
                        disabled={lines.length === 1}
                        onClick={() => {
                          setLines((current) => current.filter((_, i) => i !== index));
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={6} style={{ height: padBottom }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className={controls.button}
          onClick={() => {
            setLines((current) => [...current, newLine()]);
          }}
        >
          Add line
        </button>
        <p className={styles.total}>
          <span>Total</span> <span data-testid="order-total">{rupees(orderTotalOf(lines))}</span>
        </p>
        {inactiveVendor && (
          <div role="alert" className={styles.alert}>
            <p>{`${inactiveVendor} is deactivated. Choose another vendor.`}</p>
          </div>
        )}
        {conflict && (
          <div role="alert" className={styles.alert}>
            <p>This order changed since you opened it.</p>
            {reload && (
              <button
                type="button"
                className={controls.button}
                onClick={() => {
                  // Discards the edits only once the guard's prompt says so (ui.md).
                  guard.confirmDiscard(reload);
                }}
              >
                Reload order
              </button>
            )}
          </div>
        )}
        {failure && (
          <div role="alert" className={styles.alert}>
            <p>{failure}</p>
          </div>
        )}
        <div className={styles.actions}>
          <button type="submit" className={controls.primary} disabled={!valid || form.pending}>
            {submitLabel}
          </button>
          <Link to={cancelTo}>Cancel</Link>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}

/**
 * Raise a draft, Buyers only. Each save sends the attempt's Idempotency-Key: the same order
 * sent again (a retry after a failure) reuses it, so a create whose answer was lost is
 * never made twice; any change makes it a new attempt with a new key (research R5).
 */
export function NewOrder() {
  const attempt = useRef<{ key: string; body: string }>(undefined);
  return (
    <OrderForm
      heading="New order"
      submitLabel="Create order"
      start={{ lines: [] }}
      cancelTo="/"
      send={(body) => {
        const signature = JSON.stringify(body);
        if (attempt.current?.body !== signature) {
          attempt.current = { key: newIdempotencyKey(), body: signature };
        }
        return createOrder(body, attempt.current.key);
      }}
    />
  );
}

/** The form's start from a stored order: its vendor and lines, ids kept, amounts as text. */
function startOf(order: Order): OrderFormStart {
  return {
    vendor: { id: order.vendor.id, name: order.vendor.name },
    lines: order.lines.map(({ id, description, quantity, unitPrice }) => ({
      id,
      description,
      quantity: String(quantity),
      unitPrice,
    })),
  };
}

/**
 * Edit a draft, its owner only: the full line set sent with If-Match. The form keeps the
 * version it started from: a background refetch neither resets the edits nor moves their
 * If-Match (the save is then refused as stale and offers Reload order); only Reload order,
 * after the guard's prompt, starts the form afresh from what is stored now.
 */
export function EditOrder() {
  const { id = '' } = useParams();
  const order = useOrder(id);
  const states = useQueryStates(order, { loadingLabel: 'Loading the order' });
  const [editing, setEditing] = useState<Order>();
  if (states.view) {
    return (
      <>
        <title>Edit order · Purchase Orders</title>
        <h1>Edit order</h1>
        {states.view}
      </>
    );
  }
  // The first version loaded is the one edited; React re-renders at once with it set.
  if (editing === undefined) setEditing(states.data);
  const current = editing ?? states.data;
  return (
    <OrderForm
      key={current.version}
      heading={`Edit ${current.poNumber}`}
      submitLabel="Save changes"
      start={startOf(current)}
      cancelTo={`/orders/${id}`}
      send={(body) => editOrder(id, current.version, body)}
      reload={() =>
        void order.refetch().then((result) => {
          if (result.data) setEditing(result.data);
        })
      }
    />
  );
}

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
import { Link, useNavigate } from 'react-router';
import { isFieldCode } from '@po/contracts';
import { newIdempotencyKey } from '../../api/idempotency-key';
import { failureMessage, type ApiFailure } from '../../api/submit';
import { SEARCH_DEBOUNCE_MS } from '../../components/SearchField';
import { fieldMessageFor } from '../../errors/messages';
import { useApiForm } from '../../hooks/useApiForm';
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
import { createOrder, useActiveVendors, useOrderSaved, type CreateOrderBody } from './queries';
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

/**
 * Raise a draft (specs/004-draft-orders/contracts/ui.md): a vendor picker over active
 * vendors, a virtualised line table with row-level validation and live exact totals, and
 * Create, which sends one request at a time with the attempt's Idempotency-Key. The same
 * order sent again (a retry after a failure) reuses its key, so a create whose answer was
 * lost is never made twice; any change makes it a new attempt with a new key.
 */
export function NewOrder() {
  const navigate = useNavigate();
  const saved = useOrderSaved();
  const form = useApiForm();
  const nextKey = useRef(1);
  const newLine = (): LineDraft => ({
    key: nextKey.current++,
    description: '',
    quantity: '',
    unitPrice: '',
  });
  const [lines, setLines] = useState<LineDraft[]>(() => [newLine()]);
  const [vendor, setVendor] = useState<Vendor>();
  const [search, setSearch] = useState('');
  const [inactiveVendor, setInactiveVendor] = useState<string>();
  const vendorInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ key: string; body: string }>(undefined);
  const scroller = useRef<HTMLDivElement>(null);

  const q = useDebounced(search, SEARCH_DEBOUNCE_MS).trim();
  const vendors = useActiveVendors(q === '' ? undefined : q);
  const dirty =
    vendor !== undefined || lines.some((l) => l.description || l.quantity || l.unitPrice);
  const guard = useUnsavedChangesGuard(dirty);

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
    const body: CreateOrderBody = {
      vendorId: vendor.id,
      lines: lines.map(lineBodyOf),
    } as CreateOrderBody;
    // One attempt per order as sent: the same order again reuses its key (research R5).
    const signature = JSON.stringify(body);
    if (attempt.current?.body !== signature) {
      attempt.current = { key: newIdempotencyKey(), body: signature };
    }
    const key = attempt.current.key;
    const outcome = await form.send(() => createOrder(body, key));
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

  const failure =
    form.failure && form.failure.problem.code !== 'VENDOR_INACTIVE'
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
      <title>New order · Purchase Orders</title>
      <h1>New order</h1>
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
        {failure && (
          <div role="alert" className={styles.alert}>
            <p>{failure}</p>
          </div>
        )}
        <div className={styles.actions}>
          <button type="submit" className={controls.primary} disabled={!valid || form.pending}>
            Create order
          </button>
          <Link to="/">Cancel</Link>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}

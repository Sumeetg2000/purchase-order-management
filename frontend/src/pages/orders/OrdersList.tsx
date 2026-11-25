import {
  formatInr,
  orderListQuery,
  ORDER_STATUSES,
  PO_NUMBER_PREFIX_MAX,
  toMoney,
  type OrderStatus,
  type ReceiptProgress,
} from '@po/contracts';
import { Link } from 'react-router';
import { useCan } from '../../auth/can';
import { useCurrentUser } from '../../auth/current-user';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { formatDate } from '../../format/date';
import { pickOne, TEXT, useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { useOrderList } from './queries';
import { receiptBadge } from './receipt-progress';
import { ORDER_STATUS_LABELS } from './status';
import css from './orders.module.css';

const styles = classes(
  css,
  'header',
  'filters',
  'filter',
  'fieldError',
  'alert',
  'lines',
  'number',
  'hint',
);
const controls = classes(controlsCss, 'primary');

/** The filters a link can carry, each checked by the contract's own rule. */
const LINK_FILTERS = ['vendorId', 'poNumber', 'createdFrom', 'createdTo'] as const;
const NO_FILTERS = {
  status: undefined,
  vendorId: undefined,
  poNumber: undefined,
  createdFrom: undefined,
  createdTo: undefined,
};
const RANGE_ERROR_ID = 'created-range-error';

/**
 * The status and, after it, the receipt badge in words (FR-021a): "Approved · Partly
 * received". A cancelled order's badge, "Cancelled · partly received", names the status
 * itself.
 */
function statusWithBadge(status: OrderStatus, progress: ReceiptProgress): string {
  const badge = receiptBadge(status, progress);
  if (badge === undefined) return ORDER_STATUS_LABELS[status];
  return status === 'CANCELLED' ? badge : `${ORDER_STATUS_LABELS[status]} · ${badge}`;
}

/**
 * The orders the caller may read (contracts/ui.md, research R7): status, vendor, PO-number
 * prefix and created dates, and the page, all in the URL, so Back, Forward and a shared
 * link show the same list. Newest first, or by PO number with a PO-number prefix.
 */
export function OrdersList() {
  const { params, show, setPage } = useListParams({
    status: ORDER_STATUSES,
    vendorId: TEXT,
    poNumber: TEXT,
    createdFrom: TEXT,
    createdTo: TEXT,
  });
  const filters = params;
  // A hand-edited or old link can hold a filter the API refuses: the page says which kind
  // and asks nothing. A reversed range is a mistake in the date filters, said there.
  const badLink = LINK_FILTERS.some(
    (field) =>
      filters[field] !== undefined &&
      !orderListQuery.shape[field].safeParse(filters[field]).success,
  );
  const reversed =
    !badLink &&
    filters.createdFrom !== undefined &&
    filters.createdTo !== undefined &&
    filters.createdFrom > filters.createdTo;
  const refused = badLink || reversed;
  const rangeError = reversed ? { 'aria-invalid': true, 'aria-describedby': RANGE_ERROR_ID } : {};
  const canCreate = useCan('createOrder');
  const roles = useCurrentUser().data?.roles ?? [];
  const approverOnly = roles.includes('APPROVER') && !roles.includes('BUYER');
  const filtered = Object.entries(filters).some(
    ([key, value]) => key !== 'page' && value !== undefined,
  );
  const states = useQueryStates(useOrderList(filters, { enabled: !refused }), {
    loadingLabel: 'Loading orders',
    isEmpty: (page) => page.items.length === 0,
    empty: filtered
      ? { title: 'No orders match', description: 'Change or clear the filters to see more.' }
      : approverOnly
        ? {
            title: 'No orders to review',
            description: 'Orders appear here once buyers submit them.',
          }
        : {
            title: 'No orders yet',
            description: canCreate
              ? 'Orders you raise appear here.'
              : 'Orders appear here once buyers raise them.',
          },
  });

  return (
    <>
      <title>Orders · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Orders</h1>
        {canCreate && (
          <Link to="/orders/new" className={controls.primary}>
            New order
          </Link>
        )}
      </div>
      <form
        role="search"
        aria-label="Filter orders"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className={styles.filter}>
          Status
          <select
            value={filters.status ?? ''}
            onChange={(event) => {
              show({ status: pickOne(event.target.value, ORDER_STATUSES) });
            }}
          >
            <option value="">Any status</option>
            {ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {ORDER_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <SearchField
          label="PO number starts with"
          className={styles.filter}
          value={filters.poNumber}
          maxLength={PO_NUMBER_PREFIX_MAX}
          onSearch={(poNumber) => {
            show({ poNumber }, { replace: true });
          }}
        />
        <label className={styles.filter}>
          Created from
          <input
            type="date"
            value={filters.createdFrom ?? ''}
            {...rangeError}
            onChange={(event) => {
              show({ createdFrom: event.target.value || undefined });
            }}
          />
        </label>
        <label className={styles.filter}>
          Created to
          <input
            type="date"
            value={filters.createdTo ?? ''}
            {...rangeError}
            onChange={(event) => {
              show({ createdTo: event.target.value || undefined });
            }}
          />
        </label>
        {reversed && (
          <p id={RANGE_ERROR_ID} className={styles.fieldError}>
            The start date is after the end date.
          </p>
        )}
        {filters.vendorId && (
          <p className={styles.hint}>
            One vendor&apos;s orders.{' '}
            <button
              type="button"
              onClick={() => {
                show({ vendorId: undefined });
              }}
            >
              Show every vendor
            </button>
          </p>
        )}
      </form>
      {badLink && (
        <div role="alert" className={styles.alert}>
          <p>This link has a filter that isn&apos;t valid.</p>
          <button
            type="button"
            onClick={() => {
              show(NO_FILTERS);
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {!refused && filters.poNumber && (
        <p className={styles.hint}>Sorted by PO number, newest first.</p>
      )}
      {refused
        ? null
        : (states.view ?? (
            <>
              {states.notice}
              <table className={styles.lines}>
                <caption className={styles.hint}>
                  {states.data.total === 1 ? '1 order' : `${String(states.data.total)} orders`}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">PO number</th>
                    <th scope="col">Vendor</th>
                    <th scope="col">Status</th>
                    <th scope="col">Lines</th>
                    <th scope="col">Total</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {states.data.items.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link to={`/orders/${order.id}`}>{order.poNumber}</Link>
                      </td>
                      <td>
                        <Link to={`/orders?vendorId=${order.vendor.id}`}>{order.vendor.name}</Link>
                      </td>
                      <td>{statusWithBadge(order.status, order.receiptProgress)}</td>
                      <td className={styles.number}>{order.lineCount}</td>
                      <td className={styles.number}>{formatInr(toMoney(order.total))}</td>
                      <td>
                        <time dateTime={order.createdAt}>{formatDate(order.createdAt)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                page={states.data.page}
                pageSize={states.data.pageSize}
                total={states.data.total}
                onPage={setPage}
              />
            </>
          ))}
    </>
  );
}

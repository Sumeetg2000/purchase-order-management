import { formatInr, ORDER_STATUSES, toMoney } from '@po/contracts';
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
import { ORDER_STATUS_LABELS } from './status';
import css from './orders.module.css';

const styles = classes(css, 'header', 'filters', 'filter', 'lines', 'number', 'hint');
const controls = classes(controlsCss, 'primary');

/** A PO-number prefix as typed: letters, digits and dashes (the contract's rule). */
const PO_PREFIX_MAX = 30;
/** A calendar date as the API takes it. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const date = (value: string | undefined) =>
    value !== undefined && DATE.test(value) ? value : undefined;
  const filters = {
    ...params,
    createdFrom: date(params.createdFrom),
    createdTo: date(params.createdTo),
  };
  const canCreate = useCan('createOrder');
  const roles = useCurrentUser().data?.roles ?? [];
  const approverOnly = roles.includes('APPROVER') && !roles.includes('BUYER');
  const filtered = Object.entries(filters).some(
    ([key, value]) => key !== 'page' && value !== undefined,
  );
  const states = useQueryStates(useOrderList(filters), {
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
          maxLength={PO_PREFIX_MAX}
          onSearch={(poNumber) => {
            show({ poNumber }, { replace: true });
          }}
        />
        <label className={styles.filter}>
          Created from
          <input
            type="date"
            value={filters.createdFrom ?? ''}
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
            onChange={(event) => {
              show({ createdTo: event.target.value || undefined });
            }}
          />
        </label>
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
      {filters.poNumber && <p className={styles.hint}>Sorted by PO number, newest first.</p>}
      {states.view ?? (
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
                  <td>{ORDER_STATUS_LABELS[order.status]}</td>
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
      )}
    </>
  );
}

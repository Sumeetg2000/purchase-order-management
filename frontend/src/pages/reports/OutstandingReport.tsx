import { AGE_BUCKETS, lineNumber, outstandingReportQuery, type AgeBucket } from '@po/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { Pager } from '../../components/Pager';
import { formatDate } from '../../format/date';
import { pickOne, TEXT, useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import { useOrder } from '../orders/queries';
import css from '../orders/orders.module.css';
import { useOutstandingReport } from './queries';
import {
  AGE_BUCKET_LABELS,
  NO_MATCHING_ORDERS,
  NOTHING_OUTSTANDING,
  ageText,
  asOfLine,
  openLinesText,
} from './report-words';

const styles = classes(css, 'header', 'filters', 'filter', 'alert', 'lines', 'number', 'hint');

/** The filters a link can carry, each checked by the contract's own rule. */
const LINK_FILTERS = ['vendorId', 'ageBucket'] as const;
const COLUMNS = 9;

/**
 * The outstanding orders report, Orders view (specs/008-outstanding-report/contracts/
 * ui.md): approved orders with something still to receive, oldest approval first, by
 * vendor and age band, in the address. A row's lines are the order's own read, fetched
 * when the row is opened.
 */
export function OutstandingReport() {
  const { params, show, setPage } = useListParams({ vendorId: TEXT, ageBucket: TEXT });
  const badLink = LINK_FILTERS.some(
    (field) =>
      params[field] !== undefined &&
      !outstandingReportQuery.shape[field].safeParse(params[field]).success,
  );
  const ageBucket = badLink ? undefined : pickOne(params.ageBucket ?? null, AGE_BUCKETS);
  const filtered = params.vendorId !== undefined || params.ageBucket !== undefined;
  const roles = useCurrentUser().data?.roles ?? [];
  const ownOnly = !roles.includes('APPROVER') && !roles.includes('ADMIN');
  const states = useQueryStates(
    useOutstandingReport(
      { vendorId: params.vendorId, ageBucket, page: params.page },
      { enabled: !badLink },
    ),
    {
      loadingLabel: 'Loading outstanding orders',
      isEmpty: (page) => page.items.length === 0,
      empty: filtered
        ? { title: NO_MATCHING_ORDERS, description: 'Change or clear the filters to see more.' }
        : { title: NOTHING_OUTSTANDING, description: 'Every approved order has been received.' },
    },
  );
  const asOf = states.data?.asOf;

  return (
    <>
      <title>Outstanding orders · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Outstanding orders</h1>
      </div>
      <ReportTabs current="orders" />
      {ownOnly && <p className={styles.hint}>Your orders</p>}
      {asOf && <p className={styles.hint}>{asOfLine(asOf)}</p>}
      <form
        role="search"
        aria-label="Filter outstanding orders"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className={styles.filter}>
          Age
          <select
            value={ageBucket ?? ''}
            onChange={(event) => {
              show({ ageBucket: pickOne(event.target.value, AGE_BUCKETS) });
            }}
          >
            <option value="">All ages</option>
            {AGE_BUCKETS.map((bucket) => (
              <option key={bucket} value={bucket}>
                {AGE_BUCKET_LABELS[bucket]}
              </option>
            ))}
          </select>
        </label>
        {params.vendorId && !badLink && (
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
              show({ vendorId: undefined, ageBucket: undefined });
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {badLink
        ? null
        : (states.view ?? (
            <>
              {states.notice}
              <table className={styles.lines}>
                <caption className={styles.hint}>
                  {states.data.total === 1
                    ? '1 outstanding order'
                    : `${String(states.data.total)} outstanding orders`}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">PO number</th>
                    <th scope="col">Vendor</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Age</th>
                    <th scope="col">Age band</th>
                    <th scope="col">Open lines</th>
                    <th scope="col">Outstanding</th>
                    <th scope="col">Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {states.data.items.map((order) => (
                    <ReportRow
                      key={order.id}
                      order={order}
                      vendorHref={`/reports/outstanding?${new URLSearchParams({
                        vendorId: order.vendor.id,
                        ...(ageBucket ? { ageBucket } : {}),
                      }).toString()}`}
                    />
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

interface ReportRowProps {
  order: {
    id: string;
    poNumber: string;
    vendor: { id: string; name: string; status: 'ACTIVE' | 'INACTIVE' };
    owner: { name: string };
    approvedAt: string;
    ageDays: number;
    ageBucket: AgeBucket;
    lineCount: number;
    openLineCount: number;
    outstandingQuantity: number;
  };
  vendorHref: string;
}

function ReportRow({ order, vendorHref }: ReportRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>
          <Link to={`/orders/${order.id}`}>{order.poNumber}</Link>
        </td>
        <td>
          <Link to={vendorHref}>{order.vendor.name}</Link>
          {order.vendor.status === 'INACTIVE' && ' (inactive)'}
        </td>
        <td>{order.owner.name}</td>
        <td>
          <time dateTime={order.approvedAt}>{formatDate(order.approvedAt)}</time>
        </td>
        <td>{ageText(order.ageDays)}</td>
        <td>{AGE_BUCKET_LABELS[order.ageBucket]}</td>
        <td className={styles.number}>{openLinesText(order.openLineCount, order.lineCount)}</td>
        <td className={styles.number}>{order.outstandingQuantity}</td>
        <td>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Show lines of ${order.poNumber}`}
            onClick={() => {
              setOpen((was) => !was);
            }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLUMNS}>
            <OrderLines id={order.id} poNumber={order.poNumber} />
          </td>
        </tr>
      )}
    </>
  );
}

/** An order's lines, from the order's own read: open lines first, then by position. */
function OrderLines({ id, poNumber }: { id: string; poNumber: string }) {
  const states = useQueryStates(useOrder(id), {
    loadingLabel: `Loading the lines of ${poNumber}`,
  });
  if (states.view) return states.view;
  // Lines come in position order; open ones are shown first, each keeping its number.
  const lines = states.data.lines
    .map((line, position) => ({ line, position }))
    .sort(
      (a, b) =>
        Number(a.line.outstandingQuantity === 0) - Number(b.line.outstandingQuantity === 0) ||
        a.position - b.position,
    );
  return (
    <table className={styles.lines} aria-label={`Lines of ${poNumber}`}>
      <thead>
        <tr>
          <th scope="col">Line</th>
          <th scope="col">Description</th>
          <th scope="col">Ordered</th>
          <th scope="col">Received</th>
          <th scope="col">Outstanding</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(({ line, position }) => (
          <tr key={line.id}>
            <td className={styles.number}>{lineNumber(position)}</td>
            <td>{line.description}</td>
            <td className={styles.number}>{line.quantity}</td>
            <td className={styles.number}>{line.receivedQuantity}</td>
            <td className={styles.number}>{line.outstandingQuantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The report's two views, as links. */
export function ReportTabs({ current }: { current: 'orders' | 'vendors' }) {
  return (
    <nav aria-label="Report views" className={styles.filters}>
      <Link to="/reports/outstanding" aria-current={current === 'orders' ? 'page' : undefined}>
        Orders
      </Link>
      <Link
        to="/reports/outstanding/vendors"
        aria-current={current === 'vendors' ? 'page' : undefined}
      >
        By vendor
      </Link>
    </nav>
  );
}

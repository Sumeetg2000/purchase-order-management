import {
  approvalQueueQuery,
  formatInr,
  ORDER_OWNER_CANNOT_ACT_LABEL,
  PO_NUMBER_PREFIX_MAX,
  toMoney,
} from '@po/contracts';
import { Link } from 'react-router';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { formatAge, formatDate } from '../../format/date';
import { TEXT, useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import css from '../orders/orders.module.css';
import { useApprovalQueue } from './queries';

const styles = classes(
  css,
  'header',
  'filters',
  'filter',
  'alert',
  'lines',
  'number',
  'hint',
  'badge',
);

/**
 * Orders waiting for the caller's approval (specs/005-submit-approve/contracts/ui.md):
 * oldest submission first, never their own; vendor and PO-number prefix filters and the
 * page in the URL; the marker on an order whose owner can no longer act.
 */
export function ApprovalQueue() {
  const { params, show, setPage } = useListParams({ vendorId: TEXT, poNumber: TEXT });
  const badLink =
    (params.vendorId !== undefined &&
      !approvalQueueQuery.shape.vendorId.safeParse(params.vendorId).success) ||
    (params.poNumber !== undefined &&
      !approvalQueueQuery.shape.poNumber.safeParse(params.poNumber).success);
  const query = useApprovalQueue(params);
  const states = useQueryStates(query, {
    loadingLabel: 'Loading the approval queue',
    isEmpty: (page) => page.items.length === 0,
    empty:
      params.vendorId || params.poNumber
        ? { title: 'No orders match', description: 'Change or clear the filters to see more.' }
        : { title: 'Nothing to approve', description: 'No orders are waiting for your approval.' },
  });
  return (
    <>
      <title>Approvals · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Approvals</h1>
      </div>
      <form
        role="search"
        aria-label="Filter the approval queue"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <SearchField
          label="PO number starts with"
          className={styles.filter}
          value={params.poNumber}
          maxLength={PO_NUMBER_PREFIX_MAX}
          onSearch={(poNumber) => {
            show({ poNumber }, { replace: true });
          }}
        />
        {params.vendorId && (
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
              show({ vendorId: undefined, poNumber: undefined });
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      {params.poNumber && <p className={styles.hint}>Sorted by PO number, newest first.</p>}
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.lines} aria-label="Orders waiting for approval">
            <caption className={styles.hint}>
              {states.data.total === 1
                ? '1 order waiting'
                : `${String(states.data.total)} orders waiting`}
            </caption>
            <thead>
              <tr>
                <th scope="col">PO number</th>
                <th scope="col">Buyer</th>
                <th scope="col">Vendor</th>
                <th scope="col">Total</th>
                <th scope="col">Step</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link to={`/orders/${item.id}`}>{item.poNumber}</Link>
                    {!item.ownerCanAct && (
                      <>
                        {' '}
                        <span className={styles.badge}>{ORDER_OWNER_CANNOT_ACT_LABEL}</span>
                      </>
                    )}
                  </td>
                  <td>{item.owner.name}</td>
                  <td>
                    <Link to={`/approvals?vendorId=${item.vendor.id}`}>{item.vendor.name}</Link>
                  </td>
                  <td className={styles.number}>{formatInr(toMoney(item.total))}</td>
                  <td>
                    {item.currentStep.step} of {item.currentStep.of}
                  </td>
                  <td>
                    {formatAge(item.submittedAt)} ·{' '}
                    <time dateTime={item.submittedAt}>{formatDate(item.submittedAt)}</time>
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

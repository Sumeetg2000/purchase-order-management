import { AGE_BUCKETS } from '@po/contracts';
import { Link } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { Pager } from '../../components/Pager';
import { formatDate } from '../../format/date';
import { useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import css from '../orders/orders.module.css';
import { ReportTabs } from './OutstandingReport';
import { useOutstandingVendors } from './queries';
import { AGE_BUCKET_LABELS, NOTHING_OUTSTANDING, asOfLine } from './report-words';

const styles = classes(css, 'header', 'lines', 'number', 'hint');

/**
 * The outstanding report's By vendor view (specs/008-outstanding-report/contracts/ui.md):
 * per vendor with anything outstanding, its orders per age band and its oldest approval,
 * oldest first; each vendor opens the Orders view filtered to it.
 */
export function OutstandingVendors() {
  const { params, setPage } = useListParams({});
  const roles = useCurrentUser().data?.roles ?? [];
  const ownOnly = !roles.includes('APPROVER') && !roles.includes('ADMIN');
  const states = useQueryStates(useOutstandingVendors({ page: params.page }), {
    loadingLabel: 'Loading outstanding orders by vendor',
    isEmpty: (page) => page.items.length === 0,
    empty: { title: NOTHING_OUTSTANDING, description: 'Every approved order has been received.' },
  });
  const asOf = states.data?.asOf;

  return (
    <>
      <title>Outstanding orders by vendor · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Outstanding orders</h1>
      </div>
      <ReportTabs current="vendors" />
      {ownOnly && <p className={styles.hint}>Your orders</p>}
      {asOf && <p className={styles.hint}>{asOfLine(asOf)}</p>}
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.lines}>
            <caption className={styles.hint}>
              {states.data.total === 1
                ? '1 vendor with outstanding orders'
                : `${String(states.data.total)} vendors with outstanding orders`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Orders</th>
                {AGE_BUCKETS.map((bucket) => (
                  <th key={bucket} scope="col">
                    {AGE_BUCKET_LABELS[bucket]}
                  </th>
                ))}
                <th scope="col">Oldest approval</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((row) => (
                <tr key={row.vendor.id}>
                  <td>
                    <Link to={`/reports/outstanding?vendorId=${row.vendor.id}`}>
                      {row.vendor.name}
                    </Link>
                    {row.vendor.status === 'INACTIVE' && ' (inactive)'}
                  </td>
                  <td className={styles.number}>{row.orderCount}</td>
                  {AGE_BUCKETS.map((bucket) => (
                    <td key={bucket} className={styles.number}>
                      {row.byBucket[bucket]}
                    </td>
                  ))}
                  <td>
                    <time dateTime={row.oldestApprovedOn}>
                      {formatDate(row.oldestApprovedOn)}
                    </time>
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

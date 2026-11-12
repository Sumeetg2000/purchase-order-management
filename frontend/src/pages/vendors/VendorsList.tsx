import {
  VENDOR_NAME_MAX,
  VENDOR_STATUS_FILTER_DEFAULT,
  VENDOR_STATUS_FILTERS,
  type VendorStatusFilter,
} from '@po/contracts';
import { Link } from 'react-router';
import { useCan } from '../../auth/can';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { pickOne, TEXT, useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { formatPaymentTerms } from './payment-terms';
import { useVendorList } from './queries';
import { VENDOR_FILTER_LABELS, VENDOR_STATUS_LABELS } from './status';
import css from './vendors.module.css';

const styles = classes(css, 'header', 'filters', 'filter', 'table', 'muted', 'stack');
const controls = classes(controlsCss, 'primary');

/** The words for "vendor" under a filter: "active vendor", "inactive vendor", "vendor". */
const FILTER_NOUN = {
  ACTIVE: 'active vendor',
  INACTIVE: 'inactive vendor',
  ALL: 'vendor',
} as const satisfies Record<VendorStatusFilter, string>;

/**
 * The shared vendor list (specs/003-vendors/contracts/ui.md): status filter, name prefix
 * search and page, all in the URL. Active vendors by default; Buyers can add one.
 */
export function VendorsList() {
  // ACTIVE is the API's default, so the URL leaves it out.
  const {
    params: filters,
    show,
    setPage,
  } = useListParams(
    { status: VENDOR_STATUS_FILTERS, q: TEXT },
    { defaults: { status: VENDOR_STATUS_FILTER_DEFAULT } },
  );
  const status = filters.status ?? VENDOR_STATUS_FILTER_DEFAULT;
  const canAdd = useCan('createVendor');
  const list = useVendorList(filters);
  const noun = FILTER_NOUN[status];
  const states = useQueryStates(list, {
    loadingLabel: 'Loading vendors',
    isEmpty: (page) => page.items.length === 0,
    empty: filters.q
      ? { title: `No ${noun}s match`, description: `No ${noun} name starts with “${filters.q}”.` }
      : {
          title: `No ${noun}s`,
          description:
            status === 'INACTIVE'
              ? 'Inactive vendors appear here.'
              : 'Vendors appear here once a Buyer adds them.',
        },
  });

  return (
    <>
      <title>Vendors · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Vendors</h1>
        {canAdd && (
          <Link to="/vendors/new" className={controls.primary}>
            Add vendor
          </Link>
        )}
      </div>
      <form
        role="search"
        aria-label="Filter vendors"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className={styles.filter}>
          Status
          <select
            value={status}
            onChange={(event) => {
              show({ status: pickOne(event.target.value, VENDOR_STATUS_FILTERS) });
            }}
          >
            {VENDOR_STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {VENDOR_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <SearchField
          label="Name starts with"
          className={styles.filter}
          value={filters.q}
          maxLength={VENDOR_NAME_MAX}
          onSearch={(q) => {
            show({ q }, { replace: true });
          }}
        />
      </form>
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.table}>
            <caption className={styles.muted}>
              {states.data.total === 1 ? '1 vendor' : `${String(states.data.total)} vendors`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Contact</th>
                <th scope="col">Payment terms</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((vendor) => (
                <tr key={vendor.id}>
                  <td>
                    <Link to={`/vendors/${vendor.id}`}>{vendor.name}</Link>
                  </td>
                  <td>
                    <span className={styles.stack}>
                      <span>{vendor.contactName}</span>
                      <span className={styles.muted}>{vendor.contactEmail}</span>
                    </span>
                  </td>
                  <td>{formatPaymentTerms(vendor.paymentTerms)}</td>
                  <td>{VENDOR_STATUS_LABELS[vendor.status]}</td>
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

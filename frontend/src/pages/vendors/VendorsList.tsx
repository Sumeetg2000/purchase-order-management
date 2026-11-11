import {
  ROLE,
  VENDOR_NAME_MAX,
  VENDOR_STATUS_FILTER_DEFAULT,
  VENDOR_STATUS_FILTERS,
  type VendorStatusFilter,
} from '@po/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { Pager } from '../../components/Pager';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { oneOf, pageParam, toSearch } from '../admin/search-params';
import { formatPaymentTerms } from './payment-terms';
import { useVendorList } from './queries';
import { VENDOR_FILTER_LABELS, VENDOR_STATUS_LABELS } from './status';
import css from './vendors.module.css';

const styles = classes(css, 'header', 'filters', 'filter', 'table', 'muted', 'stack');
const controls = classes(controlsCss, 'primary');

/** How long the name search waits after the last keystroke before it searches. */
export const VENDOR_SEARCH_DEBOUNCE_MS = 300;

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
  const [params, setParams] = useSearchParams();
  const filters = {
    status: oneOf(params.get('status'), VENDOR_STATUS_FILTERS),
    q: params.get('q')?.trim() || undefined,
    page: pageParam(params.get('page')),
  };
  const status = filters.status ?? VENDOR_STATUS_FILTER_DEFAULT;
  const isBuyer = useCurrentUser().data?.roles.includes(ROLE.BUYER) ?? false;
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
              ? 'Deactivated vendors appear here.'
              : 'Vendors appear here once a Buyer adds them.',
        },
  });

  const show = (next: Partial<typeof filters>, replace = false) => {
    const merged = { ...filters, page: 1, ...next };
    // ACTIVE is the API's default, so the URL leaves it out.
    const statusParam = merged.status === VENDOR_STATUS_FILTER_DEFAULT ? undefined : merged.status;
    setParams(toSearch({ status: statusParam, q: merged.q, page: merged.page }), { replace });
  };

  return (
    <>
      <title>Vendors · Purchase Orders</title>
      <div className={styles.header}>
        <h1>Vendors</h1>
        {isBuyer && (
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
              show({ status: oneOf(event.target.value, VENDOR_STATUS_FILTERS) });
            }}
          >
            {VENDOR_STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {VENDOR_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <NameSearch
          value={filters.q}
          onSearch={(q) => {
            show({ q }, true);
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
            onPage={(page) => {
              show({ page });
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * The name prefix box: searches a moment after typing stops, and follows the URL when it
 * changes another way (Back, Forward), without disturbing the text being typed.
 */
function NameSearch({
  value,
  onSearch,
}: {
  value: string | undefined;
  onSearch: (q: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? '');
  // The last value this box put in the URL, so its own update doesn't reset the text.
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value ?? '');
    }
  }, [value]);

  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = q;
      search.current(q);
    }, VENDOR_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  return (
    <label className={styles.filter}>
      Name starts with
      <input
        type="search"
        value={text}
        maxLength={VENDOR_NAME_MAX}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </label>
  );
}

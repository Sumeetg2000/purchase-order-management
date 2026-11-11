import { ROLE } from '@po/contracts';
import { Link, useParams } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { formatPaymentTerms } from './payment-terms';
import { useVendor } from './queries';
import { VENDOR_STATUS_LABELS } from './status';
import css from './vendors.module.css';

const styles = classes(css, 'header', 'badge', 'details', 'term', 'muted');
const controls = classes(controlsCss, 'button');

/**
 * One vendor, for every role (specs/003-vendors/contracts/ui.md). Buyers get Edit; US3 adds
 * the status actions, US5 the history tab.
 */
export function VendorDetail() {
  const { id = '' } = useParams();
  const isBuyer = useCurrentUser().data?.roles.includes(ROLE.BUYER) ?? false;
  const states = useQueryStates(useVendor(id), { loadingLabel: 'Loading the vendor' });
  if (states.view) {
    return (
      <>
        <title>Vendor · Purchase Orders</title>
        {states.view}
      </>
    );
  }
  const vendor = states.data;
  return (
    <>
      <title>{`${vendor.name} · Purchase Orders`}</title>
      {states.notice}
      <div className={styles.header}>
        <h1>{vendor.name}</h1>
        <span className={styles.badge}>{VENDOR_STATUS_LABELS[vendor.status]}</span>
        {isBuyer && (
          <Link to={`/vendors/${vendor.id}/edit`} className={controls.button}>
            Edit
          </Link>
        )}
      </div>
      <ul aria-label="Vendor details" className={styles.details}>
        <li>
          <span className={styles.term}>Contact</span>
          <span>{vendor.contactName}</span>
        </li>
        <li>
          <span className={styles.term}>Email</span>
          <span>{vendor.contactEmail}</span>
        </li>
        <li>
          <span className={styles.term}>Phone</span>
          {vendor.contactPhone === null ? (
            <span className={styles.muted}>None</span>
          ) : (
            <span>{vendor.contactPhone}</span>
          )}
        </li>
        <li>
          <span className={styles.term}>Payment terms</span>
          <span>{formatPaymentTerms(vendor.paymentTerms)}</span>
        </li>
      </ul>
    </>
  );
}

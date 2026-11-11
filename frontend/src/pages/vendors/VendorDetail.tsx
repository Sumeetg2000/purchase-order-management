import { useParams } from 'react-router';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import { formatPaymentTerms } from './payment-terms';
import { useVendor } from './queries';
import { VENDOR_STATUS_LABELS } from './status';
import css from './vendors.module.css';

const styles = classes(css, 'header', 'badge', 'details', 'term', 'muted');

/**
 * One vendor, for every role (specs/003-vendors/contracts/ui.md). US2 adds Edit; US3 the
 * status actions; US5 the history tab.
 */
export function VendorDetail() {
  const { id = '' } = useParams();
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

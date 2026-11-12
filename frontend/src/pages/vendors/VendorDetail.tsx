import { ROLE } from '@po/contracts';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { failureMessage, type ApiFailure } from '../../api/submit';
import { useCurrentUser } from '../../auth/current-user';
import { formatDate } from '../../format/date';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { formatPaymentTerms } from './payment-terms';
import { DeactivateVendorDialog } from './DeactivateVendorDialog';
import { isStaleStatusCode, useChangeVendorStatus, useVendor } from './queries';
import { VENDOR_STATUS_LABELS } from './status';
import { VendorTabs } from './VendorTabs';
import css from './vendors.module.css';

const styles = classes(css, 'header', 'badge', 'details', 'term', 'muted', 'alert');
const controls = classes(controlsCss, 'button');

/**
 * One vendor, for every role (specs/003-vendors/contracts/ui.md). Buyers get Edit and the
 * status actions: Deactivate through a dialog, Reactivate without one. US5 adds the
 * history tab.
 */
export function VendorDetail() {
  const { id = '' } = useParams();
  const isBuyer = useCurrentUser().data?.roles.includes(ROLE.BUYER) ?? false;
  const query = useVendor(id);
  const states = useQueryStates(query, { loadingLabel: 'Loading the vendor' });
  const change = useChangeVendorStatus();
  const [deactivating, setDeactivating] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  // The state update lands after the event; the ref stops a second press sending twice.
  const reactivatingRef = useRef(false);
  const [failure, setFailure] = useState<ApiFailure>();

  const reload = () => {
    setFailure(undefined);
    void query.refetch();
  };

  if (states.view) {
    return (
      <>
        <title>Vendor · Purchase Orders</title>
        {states.view}
      </>
    );
  }
  const vendor = states.data;

  const reactivate = async () => {
    if (reactivatingRef.current) return;
    reactivatingRef.current = true;
    setReactivating(true);
    setFailure(undefined);
    const outcome = await change(vendor, 'reactivate');
    reactivatingRef.current = false;
    setReactivating(false);
    if (!outcome.ok) setFailure(outcome);
  };

  return (
    <>
      <title>{`${vendor.name} · Purchase Orders`}</title>
      {states.notice}
      <div className={styles.header}>
        <h1>{vendor.name}</h1>
        <span className={styles.badge}>{VENDOR_STATUS_LABELS[vendor.status]}</span>
        {isBuyer && (
          <>
            <Link to={`/vendors/${vendor.id}/edit`} className={controls.button}>
              Edit
            </Link>
            {vendor.status === 'ACTIVE' ? (
              <button
                type="button"
                className={controls.button}
                onClick={() => {
                  setFailure(undefined);
                  setDeactivating(true);
                }}
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                className={controls.button}
                disabled={reactivating}
                onClick={() => void reactivate()}
              >
                {reactivating ? 'Reactivating…' : 'Reactivate'}
              </button>
            )}
          </>
        )}
      </div>
      {failure && (
        <div role="alert" className={styles.alert}>
          <p>{failureMessage(failure)}</p>
          {isStaleStatusCode(failure.problem.code) && (
            <button type="button" className={controls.button} onClick={reload}>
              Reload
            </button>
          )}
        </div>
      )}
      {deactivating && (
        <DeactivateVendorDialog
          vendor={vendor}
          onClose={() => {
            setDeactivating(false);
          }}
          onReload={reload}
        />
      )}
      <VendorTabs id={vendor.id} />
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
        {vendor.deactivatedAt !== null && (
          <li>
            <span className={styles.term}>Deactivated</span>
            <span>{formatDate(vendor.deactivatedAt)}</span>
          </li>
        )}
      </ul>
    </>
  );
}

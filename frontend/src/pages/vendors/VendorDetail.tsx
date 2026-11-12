import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { failureMessage } from '../../api/submit';
import { useCan } from '../../auth/can';
import { formatDate } from '../../format/date';
import { useApiForm } from '../../hooks/useApiForm';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { formatPaymentTerms } from './payment-terms';
import { DeactivateVendorDialog } from './DeactivateVendorDialog';
import { changeVendorStatus, isStaleStatusCode, useVendor, useVendorSaved } from './queries';
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
  const canEdit = useCan('updateVendor');
  const canDeactivate = useCan('deactivateVendor');
  const canReactivate = useCan('reactivateVendor');
  const query = useVendor(id);
  const states = useQueryStates(query, { loadingLabel: 'Loading the vendor' });
  const saved = useVendorSaved();
  const reactivation = useApiForm();
  const failure = reactivation.failure;
  const [deactivating, setDeactivating] = useState(false);

  const reload = () => {
    reactivation.clearFailure();
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
    const outcome = await reactivation.send(() => changeVendorStatus(vendor, 'reactivate'));
    if (outcome?.ok) saved(outcome.data);
  };

  return (
    <>
      <title>{`${vendor.name} · Purchase Orders`}</title>
      {states.notice}
      <div className={styles.header}>
        <h1>{vendor.name}</h1>
        <span className={styles.badge}>{VENDOR_STATUS_LABELS[vendor.status]}</span>
        {canEdit && (
          <Link to={`/vendors/${vendor.id}/edit`} className={controls.button}>
            Edit
          </Link>
        )}
        {vendor.status === 'ACTIVE'
          ? canDeactivate && (
              <button
                type="button"
                className={controls.button}
                onClick={() => {
                  reactivation.clearFailure();
                  setDeactivating(true);
                }}
              >
                Deactivate
              </button>
            )
          : canReactivate && (
              <button
                type="button"
                className={controls.button}
                disabled={reactivation.pending}
                onClick={() => void reactivate()}
              >
                {reactivation.pending ? 'Reactivating…' : 'Reactivate'}
              </button>
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
            <span className={styles.term}>Inactive since</span>
            <span>{formatDate(vendor.deactivatedAt)}</span>
          </li>
        )}
      </ul>
    </>
  );
}

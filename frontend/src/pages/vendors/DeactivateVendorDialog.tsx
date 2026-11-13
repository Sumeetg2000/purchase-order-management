import { ConfirmDialog } from '../../components/ConfirmDialog';
import { reloadAction, useDialogAction } from '../../hooks/useDialogAction';
import { useDraftCount } from '../orders/queries';
import { changeVendorStatus, isStaleStatusCode, useVendorSaved } from './queries';

/** The caller's drafts that use the vendor, as the dialog says it; nothing at none. */
function DraftCount({ vendorId }: { vendorId: string }) {
  const count = useDraftCount(vendorId);
  if (count.isError) return <p>Couldn&apos;t load your draft count.</p>;
  const total = count.data?.total;
  if (total === undefined || total === 0) return null;
  return (
    <p>
      {total === 1
        ? '1 of your draft orders uses this vendor.'
        : `${String(total)} of your draft orders use this vendor.`}
    </p>
  );
}

export interface DeactivateVendorDialogProps {
  vendor: { id: string; name: string; version: number };
  /** Closes the dialog; after a success the page already shows the inactive vendor. */
  onClose: () => void;
  /** Rereads the vendor, for Reload after its status or version changed. */
  onReload: () => void;
}

/**
 * Deactivate vendor (specs/003-vendors/contracts/ui.md): names the vendor and what it
 * stops, and how many of the caller's drafts use it (read through the order list, never
 * blocking the action); focus starts on "Keep active".
 */
export function DeactivateVendorDialog({ vendor, onClose, onReload }: DeactivateVendorDialogProps) {
  const saved = useVendorSaved();
  const action = useDialogAction();

  const confirm = () =>
    action.run(
      () => changeVendorStatus(vendor, 'deactivate'),
      (changed) => {
        saved(changed);
        onClose();
      },
    );

  return (
    <ConfirmDialog
      title={`Deactivate ${vendor.name}?`}
      confirmLabel="Deactivate vendor"
      cancelLabel="Keep active"
      tone="danger"
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
      errorActions={reloadAction(action.error, isStaleStatusCode, () => {
        onReload();
        onClose();
      })}
    >
      Orders using it can&apos;t be submitted or approved until it&apos;s reactivated.
      <DraftCount vendorId={vendor.id} />
    </ConfirmDialog>
  );
}

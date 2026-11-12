import { ConfirmDialog } from '../../components/ConfirmDialog';
import { reloadAction, useDialogAction } from '../../hooks/useDialogAction';
import { changeVendorStatus, isStaleStatusCode, useVendorSaved } from './queries';

export interface DeactivateVendorDialogProps {
  vendor: { id: string; name: string; version: number };
  /** Closes the dialog; after a success the page already shows the inactive vendor. */
  onClose: () => void;
  /** Rereads the vendor, for Reload after its status or version changed. */
  onReload: () => void;
}

/**
 * Deactivate vendor (specs/003-vendors/contracts/ui.md): names the vendor and what it
 * stops; focus starts on "Keep active". The caller's draft count joins in slice 3.
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
    </ConfirmDialog>
  );
}

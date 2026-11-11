import { useState } from 'react';
import type { ProblemLike } from '../../errors/messages';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { STALE_STATUS_CODES, useChangeVendorStatus } from './queries';

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
  const change = useChangeVendorStatus();
  const [error, setError] = useState<ProblemLike>();

  const confirm = async () => {
    setError(undefined);
    const outcome = await change(vendor, 'deactivate');
    if (outcome.ok) onClose();
    else setError(outcome.problem);
  };

  return (
    <ConfirmDialog
      title={`Deactivate ${vendor.name}?`}
      confirmLabel="Deactivate vendor"
      cancelLabel="Keep active"
      tone="danger"
      onConfirm={confirm}
      onClose={onClose}
      error={error}
      errorActions={
        error && STALE_STATUS_CODES.has(error.code)
          ? [
              {
                label: 'Reload',
                onPress: () => {
                  onReload();
                  onClose();
                },
              },
            ]
          : []
      }
    >
      Orders using it can&apos;t be submitted or approved until it&apos;s reactivated.
    </ConfirmDialog>
  );
}

import { useState } from 'react';
import { Button } from 'react-aria-components';
import { ConfirmDialog, type ConfirmDialogProps } from '../../components/ConfirmDialog';
import { Empty } from '../../components/Empty';
import { ErrorState } from '../../components/ErrorState';
import { Loading } from '../../components/Loading';
import { RETRYABLE_CODES } from '../../errors/messages';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';

// Development only (import.meta.env.DEV in router.tsx): every shared component in every
// state, for trying them out and for accessibility checks by hand.

const controls = classes(controlsCss, 'button');
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type DialogDemo = Omit<ConfirmDialogProps, 'onClose' | 'children'> & { body: string };

const DIALOGS: Record<string, DialogDemo> = {
  plain: {
    title: 'Submit order PO-2026-27-000123?',
    confirmLabel: 'Submit order',
    body: 'It goes to an approver because its total is above ₹1,00,000.00.',
    onConfirm: () => wait(800),
  },
  reason: {
    title: 'Cancel order PO-2026-27-000123?',
    confirmLabel: 'Cancel order',
    tone: 'danger',
    reason: { label: 'Reason for cancelling', minLength: 5, maxLength: 200 },
    body: "The supplier will be told the order is cancelled. This can't be undone.",
    onConfirm: () => wait(800),
  },
  error: {
    title: 'Approve order PO-2026-27-000123?',
    confirmLabel: 'Approve order',
    error: { code: 'SERVICE_UNAVAILABLE', correlationId: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f' },
    body: 'The buyer can then record receipts against it.',
    onConfirm: () => wait(800),
  },
};

export function Demo() {
  const [dialog, setDialog] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard(dirty);
  const open = dialog === undefined ? undefined : DIALOGS[dialog];

  return (
    <>
      <title>Component demo · Purchase Orders</title>
      <h1>Component demo</h1>

      <h2>Loading</h2>
      <Loading label="Loading orders" />

      <h2>Empty</h2>
      <Empty
        title="No orders yet"
        description="Orders you raise appear here."
        action={<Button className={controls.button}>Raise an order</Button>}
      />

      <h2>Errors</h2>
      {[...RETRYABLE_CODES, 'NOT_FOUND', 'INTERNAL_ERROR'].map((code) => (
        <ErrorState
          key={code}
          problem={{ code, correlationId: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f' }}
          onRetry={() => undefined}
        />
      ))}

      <h2>Confirmation dialog</h2>
      {Object.keys(DIALOGS).map((name) => (
        <Button
          key={name}
          className={controls.button}
          onPress={() => {
            setDialog(name);
          }}
        >
          Open the {name} dialog
        </Button>
      ))}
      {open && (
        <ConfirmDialog
          {...open}
          onClose={() => {
            setDialog(undefined);
          }}
        >
          {open.body}
        </ConfirmDialog>
      )}

      <h2>Unsaved-changes guard</h2>
      <label>
        <input
          type="checkbox"
          checked={dirty}
          onChange={(event) => {
            setDirty(event.target.checked);
          }}
        />{' '}
        This page has unsaved changes
      </label>
      {guard}
    </>
  );
}

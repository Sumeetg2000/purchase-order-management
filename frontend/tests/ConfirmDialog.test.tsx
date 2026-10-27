import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from '../src/components/ConfirmDialog';
import { axeViolations } from './support/axe';

type Overrides = Partial<ConfirmDialogProps>;

/** A trigger button that opens the dialog, as a page would. */
function Harness(overrides: Overrides) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Cancel order…
      </button>
      {open && (
        <ConfirmDialog
          title="Cancel order PO-2026-27-000123?"
          confirmLabel="Cancel order"
          tone="danger"
          onConfirm={() => Promise.resolve()}
          onClose={() => setOpen(false)}
          {...overrides}
        >
          The supplier will be told the order is cancelled. This can&apos;t be undone.
        </ConfirmDialog>
      )}
    </>
  );
}

async function openDialog(overrides: Overrides = {}) {
  const user = userEvent.setup();
  const view = render(<Harness {...overrides} />);
  await user.click(screen.getByRole('button', { name: 'Cancel order…' }));
  const dialog = await screen.findByRole('alertdialog');
  return { user, view, dialog };
}

const deferred = () => {
  let resolve = () => undefined as unknown;
  const promise = new Promise<void>((r) => {
    resolve = r as () => unknown;
  });
  return { promise, resolve };
};

describe('[NFR-FE-09] ConfirmDialog', () => {
  it('[NFR-FE-09] is an alertdialog labelled by its title and described by its body', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Cancel order PO-2026-27-000123?');
    expect(dialog).toHaveAccessibleDescription(
      "The supplier will be told the order is cancelled. This can't be undone.",
    );
  });

  it('[NFR-FE-09] starts with focus on the safe button', async () => {
    await openDialog();
    expect(screen.getByRole('button', { name: 'Go back' })).toHaveFocus();
  });

  it('[NFR-FE-09] Escape, an outside click and the safe button close it, and focus returns to the trigger', async () => {
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel order…' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Cancel order…' }));
    await screen.findByRole('alertdialog');
    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Cancel order…' }));
    await user.click(await screen.findByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel order…' })).toHaveFocus();
  });

  it('[NFR-FE-09] while pending, confirm is disabled and nothing closes it', async () => {
    const pending = deferred();
    const onClose = vi.fn();
    const { user } = await openDialog({ onConfirm: () => pending.promise, onClose });
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByRole('button', { name: /Cancel order/ })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(document.body);
    expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    pending.resolve();
  });

  it('[NFR-FE-09] a double click calls onConfirm once', async () => {
    const onConfirm = vi.fn(() => new Promise<void>(() => undefined));
    const { user } = await openDialog({ onConfirm });
    await user.dblClick(screen.getByRole('button', { name: 'Cancel order' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('[NFR-FE-09] with a reason, confirm stays disabled until the reason is valid, and receives it', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const { user } = await openDialog({
      onConfirm,
      reason: { label: 'Reason for cancelling', minLength: 5, maxLength: 200 },
    });
    const confirm = screen.getByRole('button', { name: 'Cancel order' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Reason for cancelling' }), ' abc ');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Reason for cancelling' }), 'defgh');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('abc defgh');
  });

  it('[NFR-FE-09] shows an error and its actions inside the dialog, with the request id', async () => {
    const reload = vi.fn();
    await openDialog({
      error: { code: 'SERVICE_UNAVAILABLE', correlationId: 'req-dialog-0001' },
      errorActions: [{ label: 'Reload order', onPress: reload }],
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The service is temporarily unavailable');
    expect(dialog).toHaveTextContent('req-dialog-0001');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload order' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('[NFR-FE-05] has no axe violations, plain or with a reason and an error', async () => {
    const { dialog } = await openDialog({
      reason: { label: 'Reason for cancelling', minLength: 5, maxLength: 200 },
      error: { code: 'INTERNAL_ERROR', correlationId: 'req-dialog-0002' },
    });
    expect(await axeViolations(dialog)).toEqual([]);
  });
});

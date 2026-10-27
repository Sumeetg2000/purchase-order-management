import { useId, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  Heading,
  Label,
  Modal,
  ModalOverlay,
  TextArea,
  TextField,
} from 'react-aria-components';
import type { ProblemLike } from '../errors/messages';
import { problemFrom } from '../errors/problem';
import { classes } from '../styles/classes';
import controlsCss from '../styles/controls.module.css';
import css from './ConfirmDialog.module.css';
import { ErrorState } from './ErrorState';

const styles = classes(css, 'overlay', 'modal', 'dialog', 'body', 'reason', 'actions');
const controls = classes(controlsCss, 'button', 'primary', 'danger');

export interface ConfirmDialogProps {
  /** Names the action and the object: "Cancel order PO-2026-27-000123?" */
  title: string;
  /** The consequence in plain words, plus the key facts. */
  children: ReactNode;
  /** The action, e.g. "Cancel order". Never "OK" or "Yes" (a lint rule checks literals). */
  confirmLabel: string;
  /** The safe button, which closes the dialog and has the initial focus. */
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** When set, a reason is required: confirm stays disabled until it is valid. */
  reason?: { label: string; minLength: number; maxLength: number };
  /** Called once per press, with the trimmed reason when one is required. */
  onConfirm: (reason?: string) => Promise<void>;
  /** Escape, an outside click and the safe button call it, except while pending. */
  onClose: () => void;
  /**
   * Shown inside the dialog with its mapped message and next step. A rejected onConfirm is
   * shown the same way when the caller passes no error.
   */
  error?: ProblemLike | undefined;
  /** Extra actions for the error, such as reloading after a version conflict. */
  errorActions?: readonly { label: string; onPress: () => void }[];
}

/**
 * The one confirmation dialog (ADR-0018, contracts/ui-components.md). Render it to open
 * it; the caller unmounts it on close. Focus starts on the safe button, is trapped inside
 * and returns to the trigger.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Go back',
  tone = 'default',
  reason,
  onConfirm,
  onClose,
  error,
  errorActions = [],
}: ConfirmDialogProps) {
  const bodyId = useId();
  const [reasonText, setReasonText] = useState('');
  const [pending, setPending] = useState(false);
  // A rejected onConfirm, shown inside the dialog until the next attempt.
  const [failure, setFailure] = useState<ProblemLike | undefined>();
  // The state update lands after the event, so a ref stops a second press of a double
  // click from calling onConfirm again.
  const pendingRef = useRef(false);

  const shownError = error ?? failure;
  const trimmed = reasonText.trim();
  const reasonValid =
    !reason || (trimmed.length >= reason.minLength && trimmed.length <= reason.maxLength);

  const confirm = async () => {
    if (pendingRef.current || !reasonValid) return;
    pendingRef.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await onConfirm(reason ? trimmed : undefined);
    } catch (error) {
      // Never an unhandled rejection: the dialog stays open and says what happened.
      setFailure(problemFrom(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <ModalOverlay
      isOpen
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open && !pendingRef.current) onClose();
      }}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog role="alertdialog" aria-describedby={bodyId} className={styles.dialog}>
          <Heading slot="title">{title}</Heading>
          <div id={bodyId} className={styles.body}>
            {children}
          </div>
          {reason && (
            <TextField
              className={styles.reason}
              value={reasonText}
              onChange={setReasonText}
              maxLength={reason.maxLength}
              isDisabled={pending}
              isRequired
            >
              <Label>{reason.label}</Label>
              <TextArea rows={3} />
            </TextField>
          )}
          {shownError && <ErrorState problem={shownError} />}
          <div className={styles.actions}>
            {errorActions.map((action) => (
              <Button
                key={action.label}
                className={controls.button}
                onPress={action.onPress}
                isDisabled={pending}
              >
                {action.label}
              </Button>
            ))}
            <Button autoFocus className={controls.button} onPress={onClose} isDisabled={pending}>
              {cancelLabel}
            </Button>
            <Button
              className={tone === 'danger' ? controls.danger : controls.primary}
              onPress={() => void confirm()}
              isDisabled={pending || !reasonValid}
            >
              {pending ? `${confirmLabel}…` : confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

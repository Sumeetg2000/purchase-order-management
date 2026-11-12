import { ACCESS_REQUEST_NOTE_MAX_LENGTH } from '@po/contracts';
import { useState } from 'react';
import { Label, TextArea, TextField } from 'react-aria-components';
import { api } from '../../api/app-client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { classes } from '../../styles/classes';
import css from './admin.module.css';
import { useDialogAction } from './dialog-action';

const styles = classes(css, 'note');

export interface DismissDialogProps {
  request: { id: string; user: { name: string } };
  onDone: (message: string) => void;
  onClose: () => void;
}

/** Dismiss access request (ADR-0018), with an optional note the user will see. */
export function DismissDialog({ request, onDone, onClose }: DismissDialogProps) {
  const [note, setNote] = useState('');
  const action = useDialogAction();
  const { name } = request.user;

  const confirm = () => {
    const trimmed = note.trim();
    return action.run(
      () =>
        api.POST('/admin/access-requests/{id}/dismiss', {
          params: { path: { id: request.id } },
          body: trimmed ? { note: trimmed } : {},
        }),
      () => {
        onDone(`Request from ${name} dismissed.`);
      },
    );
  };

  return (
    <ConfirmDialog
      title={`Dismiss the request from ${name}?`}
      confirmLabel="Dismiss request"
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
      errorLabels={{ 'body.note': 'Note' }}
    >
      <p>They&apos;ll see that their request was dismissed, with your note if you add one.</p>
      <TextField
        className={styles.note}
        value={note}
        onChange={setNote}
        maxLength={ACCESS_REQUEST_NOTE_MAX_LENGTH}
      >
        <Label>Note for {name} (optional)</Label>
        <TextArea rows={3} />
      </TextField>
    </ConfirmDialog>
  );
}

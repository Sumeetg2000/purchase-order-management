import { USER_NAME_MAX_LENGTH } from '@po/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, TextField } from 'react-aria-components';
import { api } from '../../api/app-client';
import { failureMessage } from '../../api/submit';
import { CURRENT_USER_KEY, useCurrentUser, type CurrentUser } from '../../auth/current-user';
import { formatDate } from '../../format/date';
import { roleSetLabel } from '../../format/roles';
import { useApiForm } from '../../hooks/useApiForm';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './profile.module.css';

const styles = classes(
  css,
  'section',
  'form',
  'field',
  'fieldError',
  'details',
  'term',
  'notice',
  'alert',
);
const controls = classes(controlsCss, 'primary');

const NAME_PATH = 'body.name';

/** The name, the only field a user edits (saved with no dialog), and the rest read-only. */
export function DetailsSection() {
  const user = useCurrentUser().data;
  // Kept here: the form below starts again after a save.
  const [saved, setSaved] = useState(false);
  if (!user) return null;
  // Keyed by the saved name, so the field starts again from it after a save.
  return <DetailsForm key={user.name} user={user} saved={saved} onSaved={setSaved} />;
}

function DetailsForm({
  user,
  saved,
  onSaved,
}: {
  user: CurrentUser;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const form = useApiForm();
  const fieldError = form.fieldError(NAME_PATH);
  const failure = form.failure && !fieldError ? failureMessage(form.failure) : undefined;
  const guard = useUnsavedChangesGuard(name.trim() !== user.name);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcome = await form.send(() => api.PATCH('/me', { body: { name } }));
    if (!outcome?.ok) return;
    guard.release();
    onSaved(true);
    queryClient.setQueryData(CURRENT_USER_KEY, outcome.data);
  }

  return (
    <section className={styles.section} aria-labelledby="profile-details">
      <h2 id="profile-details">Your details</h2>
      {saved && (
        <p role="status" className={styles.notice}>
          Your name is saved.
        </p>
      )}
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <TextField
          className={styles.field}
          value={name}
          onChange={(value) => {
            setName(value);
            onSaved(false);
          }}
          maxLength={USER_NAME_MAX_LENGTH}
          isInvalid={fieldError !== undefined}
          isRequired
        >
          <Label>Name</Label>
          <Input autoComplete="name" />
          <FieldError className={styles.fieldError}>{fieldError}</FieldError>
        </TextField>
        {failure && (
          <p role="alert" className={styles.alert}>
            {failure}
          </p>
        )}
        <div>
          <button type="submit" className={controls.primary} disabled={form.pending}>
            Save name
          </button>
        </div>
      </form>
      <ul aria-label="Account" className={styles.details}>
        <li>
          <span className={styles.term}>Email</span>
          <span>{user.email}</span>
        </li>
        <li>
          <span className={styles.term}>Role</span>
          <span>{roleSetLabel(user.roles)}</span>
        </li>
        <li>
          <span className={styles.term}>Signed up</span>
          <span>{formatDate(user.createdAt)}</span>
        </li>
      </ul>
      {guard.dialog}
    </section>
  );
}

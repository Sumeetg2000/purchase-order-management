import { PASSWORD_MAX_LENGTH } from '@po/contracts';
import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { api } from '../../api/app-client';
import { fieldFailure } from '../../api/submit';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PASSWORD_RULE } from '../../errors/messages';
import { useApiForm } from '../../hooks/useApiForm';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './profile.module.css';

const styles = classes(css, 'section', 'form', 'field', 'hint', 'fieldError', 'notice');
const controls = classes(controlsCss, 'primary');

const FIELDS = { current: 'body.currentPassword', next: 'body.newPassword' } as const;

/** Change password (ADR-0018): confirmed, since the user's other sessions end. */
export function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirming, setConfirming] = useState(false);
  const form = useApiForm();
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof typeof FIELDS, string | undefined>>
  >({});
  const [changed, setChanged] = useState(false);

  function ask(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setChanged(false);
    form.clearFailure();
    setFieldErrors({});
    setConfirming(true);
  }

  async function change() {
    const outcome = await form.send(() =>
      api.POST('/auth/change-password', {
        body: { currentPassword: current, newPassword: next },
      }),
    );
    if (!outcome) return;
    if (!outcome.ok) {
      const errors = {
        current: fieldFailure(outcome, FIELDS.current),
        next: fieldFailure(outcome, FIELDS.next),
      };
      if (errors.current || errors.next) {
        // A field's own error belongs on the form, next to the field.
        setFieldErrors(errors);
        setConfirming(false);
      }
      return;
    }
    setConfirming(false);
    setFieldErrors({});
    setCurrent('');
    setNext('');
    setChanged(true);
  }

  return (
    <section className={styles.section} aria-labelledby="profile-password">
      <h2 id="profile-password">Change password</h2>
      {changed && (
        <p role="status" className={styles.notice}>
          Your password is changed. Your other sessions were logged out.
        </p>
      )}
      <form className={styles.form} onSubmit={ask}>
        <TextField
          className={styles.field}
          type="password"
          value={current}
          onChange={(value) => {
            setCurrent(value);
            setFieldErrors((errors) => ({ ...errors, current: undefined }));
          }}
          maxLength={PASSWORD_MAX_LENGTH}
          isInvalid={fieldErrors.current !== undefined}
          isRequired
        >
          <Label>Current password</Label>
          <Input autoComplete="current-password" />
          <FieldError className={styles.fieldError}>{fieldErrors.current}</FieldError>
        </TextField>
        <TextField
          className={styles.field}
          type="password"
          value={next}
          onChange={(value) => {
            setNext(value);
            setFieldErrors((errors) => ({ ...errors, next: undefined }));
          }}
          isInvalid={fieldErrors.next !== undefined}
          isRequired
        >
          <Label>New password</Label>
          <Input autoComplete="new-password" />
          <Text slot="description" className={styles.hint}>
            {PASSWORD_RULE}
          </Text>
          <FieldError className={styles.fieldError}>{fieldErrors.next}</FieldError>
        </TextField>
        <div>
          <button type="submit" className={controls.primary}>
            Change password
          </button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          title="Change your password?"
          confirmLabel="Change password"
          onConfirm={change}
          onClose={() => {
            setConfirming(false);
          }}
          error={form.failure}
        >
          <p>Your other sessions will be logged out.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

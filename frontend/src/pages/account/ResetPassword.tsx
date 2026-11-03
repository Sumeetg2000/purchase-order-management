import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { Link } from 'react-router';
import { useFragmentToken } from '../../auth/fragment-token';
import { api } from '../../api/app-client';
import { failureMessage, fieldFailure, submit } from '../../api/submit';
import { PASSWORD_RULE, sentenceFor } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';

const styles = classes(css, 'page', 'form', 'field', 'hint', 'fieldError', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

const PASSWORD_PATH = 'body.newPassword';

/**
 * Reset or set a password from a one-time link (ADR-0017). The token is read once, then
 * removed from the address bar, so it stays out of history and any shared screenshot.
 */
export function ResetPassword() {
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();

  async function setNewPassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setFailure(undefined);
    setFieldError(undefined);
    const outcome = await submit(() =>
      api.POST('/auth/reset-password', { body: { token, newPassword: password } }),
    );
    setPending(false);
    if (outcome.ok) {
      setDone(true);
      return;
    }
    const field = fieldFailure(outcome, PASSWORD_PATH);
    if (field) setFieldError(field);
    else setFailure(failureMessage(outcome));
  }

  return (
    <div className={styles.page}>
      <title>Set a new password · Purchase Orders</title>
      <h1>Set a new password</h1>
      {done ? (
        <p role="status" className={styles.notice}>
          Your password is set. <Link to="/login">Log in</Link>
        </p>
      ) : !token ? (
        <p role="alert" className={styles.alert}>
          {sentenceFor({ code: 'INVALID_TOKEN' })}
        </p>
      ) : (
        <form className={styles.form} onSubmit={(event) => void setNewPassword(event)}>
          <TextField
            className={styles.field}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            isInvalid={fieldError !== undefined}
            isRequired
          >
            <Label>New password</Label>
            <Input />
            <Text slot="description" className={styles.hint}>
              {PASSWORD_RULE}
            </Text>
            <FieldError className={styles.fieldError}>{fieldError}</FieldError>
          </TextField>
          {failure && (
            <p role="alert" className={styles.alert}>
              {failure}
            </p>
          )}
          <button type="submit" className={controls.primary} disabled={pending}>
            Set password
          </button>
        </form>
      )}
    </div>
  );
}

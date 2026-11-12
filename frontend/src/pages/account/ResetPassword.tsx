import type { ErrorCode } from '@po/contracts';
import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { Link } from 'react-router';
import { useFragmentToken } from '../../auth/fragment-token';
import { api } from '../../api/app-client';
import { failureMessage, fieldFailure, submit, type ApiFailure } from '../../api/submit';
import { messageForProblem, PASSWORD_RULE, sentenceFor } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';
import { FORGOT_PASSWORD_PATH } from './forgot-password-link';

const styles = classes(css, 'page', 'form', 'field', 'hint', 'fieldError', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

const PASSWORD_PATH = 'body.newPassword';

/** Failures a new link fixes. A superseded link points to the latest email instead. */
const NEW_LINK_CODES: readonly string[] = [
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
] satisfies readonly ErrorCode[];

function RequestNewLink() {
  return <Link to={FORGOT_PASSWORD_PATH}>Request a new link</Link>;
}

/**
 * Reset or set a password from a one-time link (ADR-0017). The token is read once, then
 * removed from the address bar, so it stays out of history and any shared screenshot.
 */
export function ResetPassword() {
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure>();
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
    else setFailure(outcome);
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
          {sentenceFor({ code: 'INVALID_TOKEN' })} <RequestNewLink />
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
              {NEW_LINK_CODES.includes(failure.problem.code) ? (
                // The link is the next step, in place of the message's own.
                <>
                  {messageForProblem(failure.problem).message} <RequestNewLink />
                </>
              ) : (
                failureMessage(failure)
              )}
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

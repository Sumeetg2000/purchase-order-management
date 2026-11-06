import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, TextField } from 'react-aria-components';
import { Link } from 'react-router';
import { api } from '../../api/app-client';
import { failureMessage, fieldFailure, submit, type ApiFailure } from '../../api/submit';
import { useFragmentToken } from '../../auth/fragment-token';
import { sentenceFor } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';

const styles = classes(css, 'page', 'form', 'field', 'fieldError', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

const PASSWORD_PATH = 'body.password';

/**
 * Confirms an email address from its link with the password chosen at signup (ADR-0017
 * "Squatting"). The token is read once and removed from the address bar; a wrong password
 * leaves the link usable. An expired link offers a new one.
 */
export function VerifyEmail() {
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure>();
  const [fieldError, setFieldError] = useState<string>();

  async function confirm(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setFailure(undefined);
    setFieldError(undefined);
    const outcome = await submit(() =>
      api.POST('/auth/verify-email', { body: { token, password } }),
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
      <title>Confirm your email · Purchase Orders</title>
      <h1>Confirm your email</h1>
      {!token ? (
        <p role="alert" className={styles.alert}>
          {sentenceFor({ code: 'INVALID_TOKEN' })}
        </p>
      ) : done ? (
        <p role="status" className={styles.notice}>
          Your email is confirmed. <Link to="/login">Log in</Link>
        </p>
      ) : (
        <>
          <form className={styles.form} onSubmit={(event) => void confirm(event)}>
            <p>Enter the password you chose to confirm your email</p>
            <TextField
              className={styles.field}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(value) => {
                setPassword(value);
                setFieldError(undefined);
              }}
              isInvalid={fieldError !== undefined}
              isRequired
            >
              <Label>Password</Label>
              <Input />
              <FieldError className={styles.fieldError}>{fieldError}</FieldError>
            </TextField>
            {failure && (
              <p role="alert" className={styles.alert}>
                {failureMessage(failure)}
              </p>
            )}
            <button type="submit" className={controls.primary} disabled={pending}>
              Confirm email
            </button>
          </form>
          {failure?.problem.code === 'TOKEN_EXPIRED' && <ResendForm />}
        </>
      )}
    </div>
  );
}

/** Asks for a new verification link, to the address the user gives. */
function ResendForm() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [failure, setFailure] = useState<string>();

  async function resend(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const outcome = await submit(() => api.POST('/auth/resend-verification', { body: { email } }));
    setPending(false);
    if (outcome.ok) setSentTo(email);
    else setFailure(failureMessage(outcome));
  }

  if (sentTo) {
    return (
      <p role="status" className={styles.notice}>
        We sent a new verification link to {sentTo}.
      </p>
    );
  }
  return (
    <form className={styles.form} onSubmit={(event) => void resend(event)}>
      <TextField
        className={styles.field}
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        isRequired
      >
        <Label>Work email</Label>
        <Input />
      </TextField>
      {failure && (
        <p role="alert" className={styles.alert}>
          {failure}
        </p>
      )}
      <button type="submit" className={controls.primary} disabled={pending}>
        Send a new link
      </button>
    </form>
  );
}

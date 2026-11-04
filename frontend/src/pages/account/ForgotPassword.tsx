import { useState, type SyntheticEvent } from 'react';
import { Input, Label, TextField } from 'react-aria-components';
import { Link, useLocation } from 'react-router';
import { api } from '../../api/app-client';
import { failureMessage, submit, type ApiFailure } from '../../api/submit';
import { LOGIN_PATH } from '../../auth/return-to';
import { messageForProblem } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';
import type { ForgotPasswordState } from './forgot-password-link';

const styles = classes(css, 'page', 'form', 'field', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

/**
 * Asks for a password reset link (ADR-0017). Each refusal says what went wrong: an
 * unknown email offers signup, and a rate limit says how long to wait.
 */
export function ForgotPassword() {
  const state = useLocation().state as ForgotPasswordState | null;
  const [email, setEmail] = useState(state?.email ?? '');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [failure, setFailure] = useState<ApiFailure>();

  async function send(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const outcome = await submit(() => api.POST('/auth/forgot-password', { body: { email } }));
    setPending(false);
    if (outcome.ok) setSentTo(email);
    else setFailure(outcome);
  }

  return (
    <div className={styles.page}>
      <title>Reset your password · Purchase Orders</title>
      <h1>Reset your password</h1>
      {sentTo ? (
        <p role="status" className={styles.notice}>
          We sent a password reset link to {sentTo}. Check your email.
        </p>
      ) : (
        <form className={styles.form} onSubmit={(event) => void send(event)}>
          <p>
            Enter your account&apos;s email and we&apos;ll send you a link to choose a new password.
          </p>
          <TextField
            className={styles.field}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              setFailure(undefined);
            }}
            isRequired
          >
            <Label>Email</Label>
            <Input />
          </TextField>
          {failure && (
            <p role="alert" className={styles.alert}>
              {failure.problem.code === 'ACCOUNT_NOT_FOUND' ? (
                // The link is the next step, in place of the message's own.
                <>
                  {messageForProblem(failure.problem).message} <Link to="/signup">Sign up</Link>
                </>
              ) : (
                failureMessage(failure)
              )}
            </p>
          )}
          <button type="submit" className={controls.primary} disabled={pending}>
            Send reset link
          </button>
        </form>
      )}
      <p>
        <Link to={LOGIN_PATH}>Back to log in</Link>
      </p>
    </div>
  );
}

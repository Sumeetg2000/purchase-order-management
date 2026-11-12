import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Input, Label, TextField } from 'react-aria-components';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/app-client';
import { failureMessage, type ApiFailure } from '../../api/submit';
import { CURRENT_USER_KEY } from '../../auth/current-user';
import { safeReturnTo, type LoginState } from '../../auth/return-to';
import { clearEndedSession } from '../../auth/session-events';
import { messageForProblem } from '../../errors/messages';
import { useApiForm } from '../../hooks/useApiForm';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';
import { FORGOT_PASSWORD_PATH, type ForgotPasswordState } from './forgot-password-link';

const styles = classes(css, 'page', 'form', 'field', 'notice', 'alert');
const controls = classes(controlsCss, 'primary', 'link');

/** The login's fields, for a field error said at form level: the page highlights none. */
const LABELS = { 'body.email': 'Email', 'body.password': 'Password' } as const;

/** Login: each failure says exactly what went wrong (ADR-0017, ADR-0018). */
export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const state = location.state as LoginState | null;
  const ended = state?.ended;
  const loggedOut = state?.loggedOut === true;
  useEffect(() => {
    // Only now that the page behind the login has gone: earlier, its guard would send it
    // to login again by itself, with a page to return to.
    if (loggedOut) queryClient.setQueryData(CURRENT_USER_KEY, null);
  }, [loggedOut, queryClient]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const form = useApiForm();
  const { pending, failure } = form;
  const [resentTo, setResentTo] = useState<string>();

  async function logIn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setResentTo(undefined);
    const outcome = await form.send(() => api.POST('/auth/login', { body: { email, password } }));
    if (!outcome?.ok) return;
    const data = outcome.data;
    clearEndedSession();
    // Logging in is the only way another user arrives in this tab: nothing cached for the
    // previous one (their sessions, access request, admin lists) may show, even briefly.
    queryClient.clear();
    queryClient.setQueryData(CURRENT_USER_KEY, data);
    await navigate(safeReturnTo(params.get('returnTo')), { replace: true });
  }

  async function resendVerification() {
    // The refusal that offers this stays on show while it is sent.
    const outcome = await form.send(
      () => api.POST('/auth/resend-verification', { body: { email } }),
      { keepFailure: true },
    );
    if (outcome?.ok) {
      form.clearFailure();
      setResentTo(email);
    }
  }

  const forgotPassword = (label: string) => (
    <Link to={FORGOT_PASSWORD_PATH} state={{ email } satisfies ForgotPasswordState}>
      {label}
    </Link>
  );

  /** Each refusal's own next step, as a link or button in place of its message's action. */
  function failureContent(shown: ApiFailure): ReactNode {
    const { message } = messageForProblem(shown.problem);
    switch (shown.problem.code) {
      case 'ACCOUNT_NOT_FOUND':
        return (
          <>
            {message} <Link to="/signup">Sign up</Link>
          </>
        );
      case 'INCORRECT_PASSWORD':
        return (
          <>
            {message} {forgotPassword('Forgot your password?')}
          </>
        );
      case 'PASSWORD_NOT_SET':
        return (
          <>
            {message} {forgotPassword('Reset your password')}
          </>
        );
      case 'ACCOUNT_NOT_VERIFIED':
        return (
          <>
            {message}{' '}
            <button
              type="button"
              className={controls.link}
              disabled={pending}
              onClick={() => void resendVerification()}
            >
              Send a new verification email
            </button>
          </>
        );
      default:
        return failureMessage(shown, { labels: LABELS });
    }
  }

  return (
    <div className={styles.page}>
      <title>Log in · Purchase Orders</title>
      <h1>Log in</h1>
      {ended && (
        <p role="status" className={styles.notice}>
          {messageForProblem(ended).message}
        </p>
      )}
      <form className={styles.form} onSubmit={(event) => void logIn(event)}>
        <TextField
          className={styles.field}
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          isRequired
        >
          <Label>Email</Label>
          <Input />
        </TextField>
        <TextField
          className={styles.field}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          isRequired
        >
          <Label>Password</Label>
          <Input />
        </TextField>
        {failure && (
          <p role="alert" className={styles.alert}>
            {failureContent(failure)}
          </p>
        )}
        {resentTo && (
          <p role="status" className={styles.notice}>
            We sent a new verification link to {resentTo}.
          </p>
        )}
        <button type="submit" className={controls.primary} disabled={pending}>
          Log in
        </button>
      </form>
      <p>
        <Link to={FORGOT_PASSWORD_PATH} state={{ email } satisfies ForgotPasswordState}>
          Forgot your password?
        </Link>
      </p>
      <p>
        New here? <Link to="/signup">Sign up</Link>
      </p>
    </div>
  );
}

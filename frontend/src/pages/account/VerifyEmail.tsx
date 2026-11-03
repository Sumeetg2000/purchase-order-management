import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Input, Label, TextField } from 'react-aria-components';
import { Link } from 'react-router';
import { api } from '../../api/app-client';
import { failureMessage, submit, type ApiFailure } from '../../api/submit';
import { useFragmentToken } from '../../auth/fragment-token';
import { Loading } from '../../components/Loading';
import { sentenceFor } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';

const styles = classes(css, 'page', 'form', 'field', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

type Verification = { state: 'pending' } | { state: 'done' } | ({ state: 'failed' } & ApiFailure);

/**
 * Confirms an email address from its link (ADR-0017): posts the token once, as soon as the
 * page opens. An expired link offers a new one.
 */
export function VerifyEmail() {
  const token = useFragmentToken();
  const [verification, setVerification] = useState<Verification>({ state: 'pending' });
  // React runs effects twice in development: the token must be posted once.
  const posted = useRef(false);

  useEffect(() => {
    if (!token || posted.current) return;
    posted.current = true;
    void submit(() => api.POST('/auth/verify-email', { body: { token } })).then((outcome) => {
      setVerification(outcome.ok ? { state: 'done' } : { state: 'failed', ...outcome });
    });
  }, [token]);

  return (
    <div className={styles.page}>
      <title>Confirm your email · Purchase Orders</title>
      <h1>Confirm your email</h1>
      {!token ? (
        <p role="alert" className={styles.alert}>
          {sentenceFor({ code: 'INVALID_TOKEN' })}
        </p>
      ) : verification.state === 'pending' ? (
        <Loading label="Confirming your email" />
      ) : verification.state === 'done' ? (
        <p role="status" className={styles.notice}>
          Your email is confirmed. <Link to="/login">Log in</Link>
        </p>
      ) : (
        <>
          <p role="alert" className={styles.alert}>
            {failureMessage(verification)}
          </p>
          {verification.problem.code === 'TOKEN_EXPIRED' && <ResendForm />}
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

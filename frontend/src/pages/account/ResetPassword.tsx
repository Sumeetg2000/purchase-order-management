import { useEffect, useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { Link, useLocation } from 'react-router';
import { api, parseProblem } from '../../api/client';
import { fieldMessages, PASSWORD_RULE, sentenceFor } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';

const styles = classes(css, 'page', 'form', 'field', 'hint', 'fieldError', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

const PASSWORD_PATH = 'body.newPassword';

/** The token in a link's fragment (#token=…): browsers never send it to a server. */
function tokenFrom(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? undefined;
}

/**
 * Reset or set a password from a one-time link (ADR-0017). The token is read once, then
 * removed from the address bar, so it stays out of history and any shared screenshot.
 */
export function ResetPassword() {
  const location = useLocation();
  const [token] = useState(() => tokenFrom(location.hash));
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setFailure(undefined);
    setFieldError(undefined);
    const { error, response } = await api.POST('/auth/reset-password', {
      body: { token, newPassword: password },
    });
    setPending(false);
    if (error === undefined) {
      setDone(true);
      return;
    }
    const problem = parseProblem(response, error);
    const field = problem.details?.find((detail) => detail.path === PASSWORD_PATH);
    if (field) setFieldError(fieldMessages[field.code]);
    else setFailure(sentenceFor(problem));
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
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
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

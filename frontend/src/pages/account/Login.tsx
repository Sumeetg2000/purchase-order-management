import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { Input, Label, TextField } from 'react-aria-components';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/app-client';
import { parseProblem } from '../../api/client';
import { CURRENT_USER_KEY } from '../../auth/current-user';
import { safeReturnTo } from '../../auth/return-to';
import { messageForProblem, sentenceFor, type ProblemLike } from '../../errors/messages';
import { problemFrom } from '../../errors/problem';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';

const styles = classes(css, 'page', 'form', 'field', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

interface LoginState {
  /** Why the session ended, when a refresh failed and sent the user here. */
  ended?: ProblemLike;
}

/** Login: each failure says exactly what went wrong (ADR-0017, ADR-0018). */
export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const ended = (location.state as LoginState | null)?.ended;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    let result;
    try {
      result = await api.POST('/auth/login', { body: { email, password } });
    } catch (thrown) {
      // The API couldn't be reached: say so, and let the form be sent again.
      setFailure(sentenceFor(problemFrom(thrown)));
      return;
    } finally {
      setPending(false);
    }
    const { data, error, response } = result;
    if (error !== undefined) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? Number.NaN);
      setFailure(
        sentenceFor(
          parseProblem(response, error),
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        ),
      );
      return;
    }
    queryClient.setQueryData(CURRENT_USER_KEY, data);
    await navigate(safeReturnTo(params.get('returnTo')), { replace: true });
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
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
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
            {failure}
          </p>
        )}
        <button type="submit" className={controls.primary} disabled={pending}>
          Log in
        </button>
      </form>
    </div>
  );
}

import { useState, type SyntheticEvent } from 'react';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { Link } from 'react-router';
import { api } from '../../api/app-client';
import { failureMessage, fieldFailure, submit, type ApiFailure } from '../../api/submit';
import { PASSWORD_RULE } from '../../errors/messages';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './account.module.css';
import { FORGOT_PASSWORD_PATH } from './forgot-password-link';

const styles = classes(css, 'page', 'form', 'field', 'hint', 'fieldError', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

/** Field paths the API may name, and each one's label here. */
const FIELDS = { name: 'body.name', email: 'body.email', password: 'body.password' } as const;

/** Signup with a work email (ADR-0017): a new account has no role and must be verified. */
export function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [failure, setFailure] = useState<ApiFailure>();

  async function signUp(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const outcome = await submit(() =>
      api.POST('/auth/signup', { body: { name, email, password } }),
    );
    setPending(false);
    if (outcome.ok) setSentTo(email);
    else setFailure(outcome);
  }

  const fieldError = (path: string) => (failure ? fieldFailure(failure, path) : undefined);
  const formError =
    failure && !Object.values(FIELDS).some((path) => fieldError(path))
      ? failureMessage(failure)
      : undefined;

  return (
    <div className={styles.page}>
      <title>Sign up · Purchase Orders</title>
      <h1>Sign up</h1>
      {sentTo ? (
        <p role="status" className={styles.notice}>
          Check your email. We sent a verification link to {sentTo}.
        </p>
      ) : (
        <form className={styles.form} onSubmit={(event) => void signUp(event)}>
          <TextField
            className={styles.field}
            autoComplete="name"
            value={name}
            onChange={setName}
            isInvalid={fieldError(FIELDS.name) !== undefined}
            isRequired
          >
            <Label>Name</Label>
            <Input />
            <FieldError className={styles.fieldError}>{fieldError(FIELDS.name)}</FieldError>
          </TextField>
          <TextField
            className={styles.field}
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            isInvalid={fieldError(FIELDS.email) !== undefined}
            isRequired
          >
            <Label>Work email</Label>
            <Input />
            <FieldError className={styles.fieldError}>{fieldError(FIELDS.email)}</FieldError>
          </TextField>
          <TextField
            className={styles.field}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            isInvalid={fieldError(FIELDS.password) !== undefined}
            isRequired
          >
            <Label>Password</Label>
            <Input />
            <Text slot="description" className={styles.hint}>
              {PASSWORD_RULE}
            </Text>
            <FieldError className={styles.fieldError}>{fieldError(FIELDS.password)}</FieldError>
          </TextField>
          {formError && (
            <p role="alert" className={styles.alert}>
              {formError}
              {failure?.problem.code === 'EMAIL_IN_USE' && (
                <>
                  {' '}
                  <Link to={FORGOT_PASSWORD_PATH}>Reset your password</Link>
                </>
              )}
            </p>
          )}
          <button type="submit" className={controls.primary} disabled={pending}>
            Sign up
          </button>
        </form>
      )}
      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </div>
  );
}

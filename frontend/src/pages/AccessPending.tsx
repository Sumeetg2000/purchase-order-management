import { ACCESS_REQUEST_MESSAGE_MAX_LENGTH, type OwnAccessRequest } from '@po/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Label, TextArea, TextField } from 'react-aria-components';
import { Navigate } from 'react-router';
import { api } from '../api/app-client';
import { dataOrThrow } from '../api/client';
import { failureMessage, submit } from '../api/submit';
import { CURRENT_USER_KEY, useCurrentUser } from '../auth/current-user';
import { ErrorState } from '../components/ErrorState';
import { Loading } from '../components/Loading';
import { problemFrom } from '../errors/problem';
import { formatDate } from '../format/date';
import { classes } from '../styles/classes';
import controlsCss from '../styles/controls.module.css';
import css from './account/account.module.css';

const styles = classes(css, 'form', 'field', 'notice', 'alert');
const controls = classes(controlsCss, 'primary');

const ACCESS_REQUEST_KEY = ['own-access-request'] as const;

/** The user's latest access request, or null if they never sent one. */
function useOwnAccessRequest() {
  return useQuery({
    queryKey: ACCESS_REQUEST_KEY,
    queryFn: async (): Promise<OwnAccessRequest | null> => {
      const result = await api.GET('/me/access-request');
      if (result.response.status === 404) return null;
      return dataOrThrow(result);
    },
  });
}

/**
 * Access pending (ADR-0018): a verified user with no role sees why, and can message the
 * administrators. Messages and the admin's note are text, never HTML.
 */
export function AccessPending() {
  const user = useCurrentUser().data;
  const request = useOwnAccessRequest();
  const queryClient = useQueryClient();
  const refused = request.isError && problemFrom(request.error).code === 'FORBIDDEN';
  useEffect(() => {
    // FORBIDDEN on the no-role route: a role arrived. Read the user again to move on.
    if (refused) void queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
  }, [refused, queryClient]);
  if (user && user.roles.length > 0) return <Navigate to="/" replace />;

  return (
    <>
      <title>Access pending · Purchase Orders</title>
      <h1>Access pending</h1>
      <p>
        Your account is active, but an administrator hasn&apos;t assigned you a role yet. You
        can&apos;t raise or approve orders until then.
      </p>
      {user && <p>You signed up on {formatDate(user.createdAt)}.</p>}
      {request.isPending ? (
        <Loading label="Loading your request" />
      ) : refused ? (
        <Loading label="Loading your account" />
      ) : request.isError ? (
        <ErrorState problem={problemFrom(request.error)} />
      ) : (
        <>
          <RequestStatus request={request.data} />
          <MessageForm />
        </>
      )}
    </>
  );
}

function RequestStatus({ request }: { request: OwnAccessRequest | null }) {
  if (request?.status === 'OPEN') {
    return <p className={styles.notice}>Request sent on {formatDate(request.updatedAt)}.</p>;
  }
  if (request?.status === 'DISMISSED') {
    return (
      <div className={styles.notice}>
        <p>Your request was dismissed.</p>
        {request.adminNote && <p>{request.adminNote}</p>}
      </div>
    );
  }
  return null;
}

/** Sends the administrators a message: opens a request, or updates the open one. */
function MessageForm() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function send(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const outcome = await submit(() => api.POST('/me/access-request', { body: { message } }));
    setPending(false);
    if (!outcome.ok) {
      setFailure(failureMessage(outcome));
      return;
    }
    queryClient.setQueryData(ACCESS_REQUEST_KEY, outcome.data);
    setMessage('');
  }

  return (
    <form className={styles.form} onSubmit={(event) => void send(event)}>
      <TextField
        className={styles.field}
        value={message}
        onChange={setMessage}
        maxLength={ACCESS_REQUEST_MESSAGE_MAX_LENGTH}
        isRequired
      >
        <Label>Message the administrator</Label>
        <TextArea rows={4} />
      </TextField>
      {failure && (
        <p role="alert" className={styles.alert}>
          {failure}
        </p>
      )}
      <button type="submit" className={controls.primary} disabled={pending}>
        Send
      </button>
    </form>
  );
}

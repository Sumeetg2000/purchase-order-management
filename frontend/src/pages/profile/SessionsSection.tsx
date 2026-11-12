import type { SessionItem } from '@po/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { useLogOutHere } from '../../auth/log-out-here';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Pager } from '../../components/Pager';
import { formatDateTime } from '../../format/date';
import { describeDevice } from '../../format/device';
import { useDialogAction } from '../../hooks/useDialogAction';
import { useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './profile.module.css';

const styles = classes(css, 'section', 'table', 'current', 'notice', 'row');
const controls = classes(controlsCss, 'button', 'danger');

const SESSIONS_KEY = ['own-sessions'] as const;

type Dialog = { kind: 'revoke'; session: SessionItem } | { kind: 'everywhere' };

/** Where the user is logged in (ADR-0018): revoke one, or log out everywhere. */
export function SessionsSection() {
  const queryClient = useQueryClient();
  const logOutHere = useLogOutHere();
  const {
    params: { page },
    setPage,
  } = useListParams({});
  const sessions = useQuery({
    queryKey: [...SESSIONS_KEY, page],
    queryFn: async () =>
      dataOrThrow(
        await api.GET('/auth/sessions', {
          params: { query: page === 1 ? {} : { page } },
        }),
      ),
  });
  const states = useQueryStates(sessions, { loadingLabel: 'Loading your sessions' });
  const [dialog, setDialog] = useState<Dialog>();
  const action = useDialogAction();
  const [done, setDone] = useState(false);

  const close = () => {
    setDialog(undefined);
    action.clearError();
  };

  async function revoke(session: SessionItem) {
    const revoked = await action.run(() =>
      api.DELETE('/auth/sessions/{id}', { params: { path: { id: session.id } } }),
    );
    if (!revoked) {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      return;
    }
    if (session.current) {
      await logOutHere();
      return;
    }
    close();
    setDone(true);
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    // The last session on a later page: show the page before instead of an empty one.
    const shown = queryClient.getQueryData<{ items: unknown[] }>([...SESSIONS_KEY, page]);
    if (page > 1 && shown?.items.length === 0) setPage(page - 1);
  }

  async function logOutEverywhere() {
    if (await action.run(() => api.POST('/auth/logout-all'))) await logOutHere();
  }

  return (
    <section className={styles.section} aria-labelledby="profile-sessions">
      <div className={styles.row}>
        <h2 id="profile-sessions">Sessions</h2>
        <button
          type="button"
          className={controls.button}
          onClick={() => {
            setDialog({ kind: 'everywhere' });
          }}
        >
          Log out everywhere
        </button>
      </div>
      {done && (
        <p role="status" className={styles.notice}>
          Session revoked.
        </p>
      )}
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.table}>
            <caption>Sessions</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">IP address</th>
                <th scope="col">Logged in</th>
                <th scope="col">Last used</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((session) => {
                const device = describeDevice(session.userAgent);
                return (
                  <tr key={session.id}>
                    <td>
                      {device}
                      {session.current && <span className={styles.current}>This device</span>}
                    </td>
                    <td>{session.ip}</td>
                    <td>{formatDateTime(session.createdAt)}</td>
                    <td>{formatDateTime(session.lastUsedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className={controls.button}
                        aria-label={`Revoke ${device} (${session.ip})`}
                        onClick={() => {
                          setDone(false);
                          setDialog({ kind: 'revoke', session });
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager
            page={states.data.page}
            pageSize={states.data.pageSize}
            total={states.data.total}
            onPage={setPage}
          />
        </>
      )}
      {dialog?.kind === 'revoke' && (
        <ConfirmDialog
          title="Revoke this session?"
          confirmLabel="Revoke session"
          tone="danger"
          onConfirm={() => revoke(dialog.session)}
          onClose={close}
          error={action.error}
        >
          <p>
            {describeDevice(dialog.session.userAgent)}, last used{' '}
            {formatDateTime(dialog.session.lastUsedAt)}.
          </p>
          {dialog.session.current && (
            <p>This is the session you&apos;re using: revoking it logs you out here.</p>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === 'everywhere' && (
        <ConfirmDialog
          title="Log out everywhere?"
          confirmLabel="Log out everywhere"
          tone="danger"
          onConfirm={logOutEverywhere}
          onClose={close}
          error={action.error}
        >
          <p>Every device, including this one, will be logged out.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

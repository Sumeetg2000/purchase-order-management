import {
  ROLE,
  ROLE_FILTERS,
  USER_SEARCH_MAX_LENGTH,
  USER_STATUS,
  USER_STATUSES,
  type AdminUserItem,
} from '@po/contracts';
import { useState } from 'react';
import { useCurrentUser } from '../../auth/current-user';
import { Pager } from '../../components/Pager';
import { SearchField } from '../../components/SearchField';
import { formatDate } from '../../format/date';
import { ROLE_LABELS, roleSetLabel, STATUS_LABELS } from '../../format/roles';
import { pickOne, TEXT, useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './admin.module.css';
import { AdminTabs } from './AdminTabs';
import { useUserList } from './queries';
import { RoleDialog } from './RoleDialog';
import { ActivationDialog, ResetDialog } from './UserDialogs';

const styles = classes(css, 'filters', 'filter', 'table', 'muted', 'actions', 'done');
const controls = classes(controlsCss, 'button');

const ROLE_FILTER_LABELS = { ...ROLE_LABELS, NONE: 'No role' } as const;

type Dialog =
  | { kind: 'role' | 'reset'; user: AdminUserItem }
  | { kind: 'activation'; user: AdminUserItem; isActive: boolean };

/**
 * Admin Users (ADR-0018): the list with its filters in the URL, and the row actions.
 * Admin rows are read-only, and the admin's own row offers no actions.
 */
export function Users() {
  const {
    params: filters,
    show,
    setPage,
  } = useListParams({ role: ROLE_FILTERS, status: USER_STATUSES, q: TEXT });
  const me = useCurrentUser().data;
  const list = useUserList(filters);
  const states = useQueryStates(list, {
    loadingLabel: 'Loading users',
    isEmpty: (page) => page.items.length === 0,
    empty: { title: 'No users match', description: 'Try other filters or another search.' },
  });
  const [dialog, setDialog] = useState<Dialog>();
  const [done, setDone] = useState<string>();

  const close = () => {
    setDialog(undefined);
  };
  const finished = (message: string) => {
    setDialog(undefined);
    setDone(message);
  };

  return (
    <>
      <title>Users · Purchase Orders</title>
      <h1>Users</h1>
      <AdminTabs />
      <form
        role="search"
        aria-label="Filter users"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className={styles.filter}>
          Role
          <select
            value={filters.role ?? ''}
            onChange={(event) => {
              show({ role: pickOne(event.target.value, ROLE_FILTERS) });
            }}
          >
            <option value="">Any role</option>
            {ROLE_FILTERS.map((role) => (
              <option key={role} value={role}>
                {ROLE_FILTER_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          Status
          <select
            value={filters.status ?? ''}
            onChange={(event) => {
              show({ status: pickOne(event.target.value, USER_STATUSES) });
            }}
          >
            <option value="">Any status</option>
            {USER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <SearchField
          label="Name or email starts with"
          className={styles.filter}
          value={filters.q}
          maxLength={USER_SEARCH_MAX_LENGTH}
          onSearch={(q) => {
            show({ q }, { replace: true });
          }}
        />
      </form>
      {done && (
        <p role="status" className={styles.done}>
          {done}
        </p>
      )}
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.table}>
            <caption className={styles.muted}>
              {states.data.total === 1 ? '1 user' : `${String(states.data.total)} users`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Last login</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{roleSetLabel(user.roles)}</td>
                  <td>{STATUS_LABELS[user.status]}</td>
                  <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}</td>
                  <td>
                    {user.id === me?.id ? (
                      <span className={styles.muted}>You</span>
                    ) : user.roles.includes(ROLE.ADMIN) ? (
                      <span className={styles.muted}>Managed by the operator</span>
                    ) : (
                      <RowActions user={user} onOpen={setDialog} />
                    )}
                  </td>
                </tr>
              ))}
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
      {dialog?.kind === 'role' && (
        <RoleDialog user={dialog.user} onDone={finished} onClose={close} />
      )}
      {dialog?.kind === 'activation' && (
        <ActivationDialog
          user={dialog.user}
          isActive={dialog.isActive}
          onDone={finished}
          onClose={close}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ResetDialog user={dialog.user} onDone={finished} onClose={close} />
      )}
    </>
  );
}

function RowActions({ user, onOpen }: { user: AdminUserItem; onOpen: (dialog: Dialog) => void }) {
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={controls.button}
        aria-label={`Change role for ${user.name}`}
        onClick={() => {
          onOpen({ kind: 'role', user });
        }}
      >
        Change role
      </button>
      {/* An unverified user becomes active only by proving their mailbox (ADR-0016). */}
      {user.status !== USER_STATUS.UNVERIFIED && (
        <button
          type="button"
          className={controls.button}
          aria-label={
            user.status === USER_STATUS.ACTIVE
              ? `Deactivate ${user.name}`
              : `Reactivate ${user.name}`
          }
          onClick={() => {
            onOpen({ kind: 'activation', user, isActive: user.status !== USER_STATUS.ACTIVE });
          }}
        >
          {user.status === USER_STATUS.ACTIVE ? 'Deactivate' : 'Reactivate'}
        </button>
      )}
      {/* A deactivated account can't use a reset; the API refuses to send one. */}
      {user.status !== USER_STATUS.DEACTIVATED && (
        <button
          type="button"
          className={controls.button}
          aria-label={`Send password reset to ${user.name}`}
          onClick={() => {
            onOpen({ kind: 'reset', user });
          }}
        >
          Send reset
        </button>
      )}
    </div>
  );
}

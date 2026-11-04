import {
  ACCESS_REQUEST_STATUS,
  ACCESS_REQUEST_STATUSES,
  type AccessRequestStatus,
  type AdminAccessRequest,
} from '@po/contracts';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Pager } from '../../components/Pager';
import { formatDate } from '../../format/date';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import css from './admin.module.css';
import { AdminTabs } from './AdminTabs';
import { DismissDialog } from './DismissDialog';
import { useAccessRequestList } from './queries';
import { RoleDialog } from './RoleDialog';
import { oneOf, pageParam, toSearch } from './search-params';

const styles = classes(css, 'filters', 'filter', 'table', 'muted', 'message', 'actions', 'done');
const controls = classes(controlsCss, 'button');

const STATUS_LABELS: Readonly<Record<AccessRequestStatus, string>> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};

type Dialog = { kind: 'assign' | 'dismiss'; request: AdminAccessRequest };

/**
 * The Access requests tab (ADR-0018): requests from users with no role, with "Assign
 * role" and "Dismiss" on open ones. Messages and notes are text, never HTML.
 */
export function AccessRequests() {
  const [params, setParams] = useSearchParams();
  const filters = {
    status: oneOf(params.get('status'), ACCESS_REQUEST_STATUSES),
    page: pageParam(params.get('page')),
  };
  const list = useAccessRequestList(filters);
  const states = useQueryStates(list, {
    loadingLabel: 'Loading access requests',
    isEmpty: (page) => page.items.length === 0,
    empty: {
      title: 'No access requests',
      description: 'Requests from users waiting for a role appear here.',
    },
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
      <title>Access requests · Purchase Orders</title>
      <h1>Access requests</h1>
      <AdminTabs />
      <div className={styles.filters}>
        <label className={styles.filter}>
          Status
          <select
            value={filters.status ?? ''}
            onChange={(event) => {
              setParams(toSearch({ status: oneOf(event.target.value, ACCESS_REQUEST_STATUSES) }));
            }}
          >
            <option value="">Any status</option>
            {ACCESS_REQUEST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {done && (
        <p role="status" className={styles.done}>
          {done}
        </p>
      )}
      {states.view ?? (
        <>
          {states.notice}
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Signed up</th>
                <th scope="col">Message</th>
                <th scope="col">Status</th>
                <th scope="col">Last updated</th>
                <th scope="col">Note</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {states.data.items.map((request) => (
                <tr key={request.id}>
                  <td>
                    {request.user.name}
                    <br />
                    <span className={styles.muted}>{request.user.email}</span>
                  </td>
                  <td>{formatDate(request.user.signedUpAt)}</td>
                  <td className={styles.message}>{request.message}</td>
                  <td>{STATUS_LABELS[request.status]}</td>
                  <td>{formatDate(request.updatedAt)}</td>
                  <td className={styles.message}>{request.adminNote}</td>
                  <td>
                    {request.status === ACCESS_REQUEST_STATUS.OPEN && (
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={controls.button}
                          aria-label={`Assign role to ${request.user.name}`}
                          onClick={() => {
                            setDialog({ kind: 'assign', request });
                          }}
                        >
                          Assign role
                        </button>
                        <button
                          type="button"
                          className={controls.button}
                          aria-label={`Dismiss request from ${request.user.name}`}
                          onClick={() => {
                            setDialog({ kind: 'dismiss', request });
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
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
            onPage={(page) => {
              setParams(toSearch({ ...filters, page }));
            }}
          />
        </>
      )}
      {dialog?.kind === 'assign' && (
        <RoleDialog user={dialog.request.user} onDone={finished} onClose={close} />
      )}
      {dialog?.kind === 'dismiss' && (
        <DismissDialog request={dialog.request} onDone={finished} onClose={close} />
      )}
    </>
  );
}

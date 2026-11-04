import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { api } from '../api/app-client';
import { CURRENT_USER_KEY, useCurrentUser } from '../auth/current-user';
import { clearEndedSession } from '../auth/session-events';
import { ROLE } from '@po/contracts';
import { useOpenRequestCount } from '../pages/admin/queries';
import { classes } from '../styles/classes';
import controlsCss from '../styles/controls.module.css';
import css from './Shell.module.css';

const styles = classes(css, 'skip', 'header', 'brand', 'nav', 'badge', 'account', 'main');
const controls = classes(controlsCss, 'button');

/** The layout every page renders in: skip link, header with navigation, and main. */
export function Shell() {
  const user = useCurrentUser().data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logOut() {
    // Whatever the API answers, this browser is logged out: its cookies are cleared or dead.
    await api.POST('/auth/logout').catch(() => undefined);
    // Logged out on purpose: no earlier reason applies any more.
    clearEndedSession();
    queryClient.setQueryData(CURRENT_USER_KEY, null);
    await navigate('/login', { replace: true });
  }

  return (
    <>
      <a className={styles.skip} href="#main">
        Skip to main content
      </a>
      <header className={styles.header}>
        <span className={styles.brand}>Purchase Orders</span>
        <nav aria-label="Main" className={styles.nav}>
          <NavLink to="/" end>
            Home
          </NavLink>
          {user?.roles.includes(ROLE.ADMIN) && <UsersLink />}
        </nav>
        {user && (
          <div className={styles.account}>
            <span>{user.name}</span>
            <button type="button" className={controls.button} onClick={() => void logOut()}>
              Log out
            </button>
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}

/** Users, with the open access-request count for admins (ADR-0018). */
function UsersLink() {
  const count = useOpenRequestCount(true).data ?? 0;
  const label =
    count > 0
      ? `Users, ${String(count)} open access ${count === 1 ? 'request' : 'requests'}`
      : undefined;
  return (
    <NavLink to="/admin/users" aria-label={label}>
      Users
      {count > 0 && (
        <span className={styles.badge} aria-hidden="true">
          {count}
        </span>
      )}
    </NavLink>
  );
}

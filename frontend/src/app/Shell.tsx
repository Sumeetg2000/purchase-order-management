import { useQueryClient } from '@tanstack/react-query';
import { Button } from 'react-aria-components';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { api } from '../api/client';
import { CURRENT_USER_KEY, useCurrentUser } from '../auth/current-user';
import { classes } from '../styles/classes';
import controlsCss from '../styles/controls.module.css';
import css from './Shell.module.css';

const styles = classes(css, 'skip', 'header', 'brand', 'nav', 'account', 'main');
const controls = classes(controlsCss, 'button');

/** The layout every page renders in: skip link, header with navigation, and main. */
export function Shell() {
  const user = useCurrentUser().data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logOut() {
    // Whatever the API answers, this browser is logged out: its cookies are cleared or dead.
    await api.POST('/auth/logout').catch(() => undefined);
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
        </nav>
        {user && (
          <div className={styles.account}>
            <span>{user.name}</span>
            <Button className={controls.button} onPress={() => void logOut()}>
              Log out
            </Button>
          </div>
        )}
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}

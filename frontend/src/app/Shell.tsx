import { NavLink, Outlet } from 'react-router';
import { classes } from '../styles/classes';
import css from './Shell.module.css';

const styles = classes(css, 'skip', 'header', 'brand', 'nav', 'main');

/** The layout every page renders in: skip link, header with navigation, and main. */
export function Shell() {
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
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}

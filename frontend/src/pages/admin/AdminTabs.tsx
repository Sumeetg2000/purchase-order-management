import { NavLink } from 'react-router';
import { classes } from '../../styles/classes';
import css from './admin.module.css';

const styles = classes(css, 'tabs');

/** Users and its Access requests tab (ADR-0018). */
export function AdminTabs() {
  return (
    <nav aria-label="User administration" className={styles.tabs}>
      <NavLink to="/admin/users" end>
        Users
      </NavLink>
      <NavLink to="/admin/users/access-requests">Access requests</NavLink>
    </nav>
  );
}

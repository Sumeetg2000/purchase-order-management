import { OPERATIONS, type UserRole } from '@po/contracts';
import { NavLink } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { classes } from '../../styles/classes';
import css from './vendors.module.css';

const styles = classes(css, 'tabs');

const HISTORY_ROLES: readonly UserRole[] = OPERATIONS.listVendorHistory.roles;

/** Details and History (contracts/ui.md), for the roles the history operation serves. */
export function VendorTabs({ id }: { id: string }) {
  const roles = useCurrentUser().data?.roles ?? [];
  if (!roles.some((role) => HISTORY_ROLES.includes(role))) return null;
  return (
    <nav aria-label="Vendor sections" className={styles.tabs}>
      <NavLink to={`/vendors/${id}`} end>
        Details
      </NavLink>
      <NavLink to={`/vendors/${id}/history`}>History</NavLink>
    </nav>
  );
}

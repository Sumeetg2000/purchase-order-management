import { ROLE } from '@po/contracts';
import { NavLink } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { classes } from '../../styles/classes';
import css from './vendors.module.css';

const styles = classes(css, 'tabs');

/** Details and History (contracts/ui.md). History is for Buyers and Admins only. */
export function VendorTabs({ id }: { id: string }) {
  const roles = useCurrentUser().data?.roles ?? [];
  if (!roles.includes(ROLE.BUYER) && !roles.includes(ROLE.ADMIN)) return null;
  return (
    <nav aria-label="Vendor sections" className={styles.tabs}>
      <NavLink to={`/vendors/${id}`} end>
        Details
      </NavLink>
      <NavLink to={`/vendors/${id}/history`}>History</NavLink>
    </nav>
  );
}

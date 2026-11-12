import { NavLink } from 'react-router';
import { useCan } from '../../auth/can';
import { classes } from '../../styles/classes';
import css from './vendors.module.css';

const styles = classes(css, 'tabs');

/** Details and History (contracts/ui.md), for the roles the history operation serves. */
export function VendorTabs({ id }: { id: string }) {
  const canReadHistory = useCan('listVendorHistory');
  if (!canReadHistory) return null;
  return (
    <nav aria-label="Vendor sections" className={styles.tabs}>
      <NavLink to={`/vendors/${id}`} end>
        Details
      </NavLink>
      <NavLink to={`/vendors/${id}/history`}>History</NavLink>
    </nav>
  );
}

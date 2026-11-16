import { NavLink } from 'react-router';
import { classes } from '../../styles/classes';
import css from './orders.module.css';

const styles = classes(css, 'tabs');

/** Details and Timeline (contracts/ui.md): whoever reads an order reads its timeline. */
export function OrderTabs({ id }: { id: string }) {
  return (
    <nav aria-label="Order sections" className={styles.tabs}>
      <NavLink to={`/orders/${id}`} end>
        Details
      </NavLink>
      <NavLink to={`/orders/${id}/timeline`}>Timeline</NavLink>
    </nav>
  );
}

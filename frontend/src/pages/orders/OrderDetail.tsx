import { formatInr, toMoney } from '@po/contracts';
import { Link, useParams } from 'react-router';
import { useCan } from '../../auth/can';
import { useCurrentUser } from '../../auth/current-user';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import { VENDOR_STATUS_LABELS } from '../vendors/status';
import { useOrder } from './queries';
import { ORDER_STATUS_LABELS } from './status';
import css from './orders.module.css';

const styles = classes(css, 'header', 'badge', 'details', 'term', 'lines', 'number', 'total');

/**
 * One order (specs/004-draft-orders/contracts/ui.md): its PO number, status, vendor as it
 * is now (with an Inactive badge), owner, lines in display order and the exact total in
 * rupees. Edit, delete and the timeline arrive with their stories.
 */
export function OrderDetail() {
  const { id = '' } = useParams();
  const states = useQueryStates(useOrder(id), { loadingLabel: 'Loading the order' });
  const me = useCurrentUser().data;
  const canEdit = useCan('editOrder');
  if (states.view) {
    return (
      <>
        <title>Order · Purchase Orders</title>
        {states.view}
      </>
    );
  }
  const order = states.data;
  return (
    <>
      <title>{`${order.poNumber} · Purchase Orders`}</title>
      {states.notice}
      <div className={styles.header}>
        <h1>{order.poNumber}</h1>
        <span className={styles.badge}>{ORDER_STATUS_LABELS[order.status]}</span>
        {canEdit && order.status === 'DRAFT' && order.owner.id === me?.id && (
          <Link to={`/orders/${order.id}/edit`}>Edit</Link>
        )}
      </div>
      <dl className={styles.details}>
        <dt className={styles.term}>Vendor</dt>
        <dd>
          {order.vendor.name}{' '}
          {order.vendor.status === 'INACTIVE' && (
            <span className={styles.badge}>{VENDOR_STATUS_LABELS.INACTIVE}</span>
          )}
        </dd>
        <dt className={styles.term}>Raised by</dt>
        <dd>{order.owner.name}</dd>
      </dl>
      <table className={styles.lines} aria-label="Lines">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price</th>
            <th scope="col">Line total</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.description}</td>
              <td className={styles.number}>{line.quantity}</td>
              <td className={styles.number}>{formatInr(toMoney(line.unitPrice))}</td>
              <td className={styles.number}>{formatInr(toMoney(line.lineTotal))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.total}>
        <span>Total</span> <span data-testid="order-total">{formatInr(toMoney(order.total))}</span>
      </p>
    </>
  );
}

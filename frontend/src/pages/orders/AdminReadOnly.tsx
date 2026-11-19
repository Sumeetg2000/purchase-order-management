import { ORDER_ADMIN_READ_ONLY_MESSAGE, ORDER_APPROVER_READ_ONLY_MESSAGE } from '@po/contracts';
import { Link } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { Forbidden } from '../Forbidden';

/**
 * In place of an order-writing page for a user who can't write orders: an Admin or a pure
 * Approver is told why, in the API's own words (ADR-0004, 2026-11-12 and 2026-11-17);
 * anyone else gets the 403 page.
 */
export function OrderWriteForbidden() {
  const roles = useCurrentUser().data?.roles ?? [];
  const reader = roles.includes('ADMIN')
    ? { who: 'Admins', message: ORDER_ADMIN_READ_ONLY_MESSAGE }
    : roles.includes('APPROVER')
      ? { who: 'Approvers', message: ORDER_APPROVER_READ_ONLY_MESSAGE }
      : null;
  if (!reader) return <Forbidden />;
  return (
    <>
      <title>Orders are read-only · Purchase Orders</title>
      <h1>Orders are read-only for {reader.who}</h1>
      <p>{reader.message}</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}

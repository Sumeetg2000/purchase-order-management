import { ORDER_ADMIN_READ_ONLY_MESSAGE } from '@po/contracts';
import { Link } from 'react-router';
import { useCurrentUser } from '../../auth/current-user';
import { Forbidden } from '../Forbidden';

/**
 * In place of an order-writing page for a user who can't write orders: an Admin is told
 * why, in the API's own words (ADR-0004, 2026-11-12); anyone else gets the 403 page.
 */
export function OrderWriteForbidden() {
  const user = useCurrentUser().data;
  if (!user?.roles.includes('ADMIN')) return <Forbidden />;
  return (
    <>
      <title>Orders are read-only · Purchase Orders</title>
      <h1>Orders are read-only for Admins</h1>
      <p>{ORDER_ADMIN_READ_ONLY_MESSAGE}</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}

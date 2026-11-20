import { formatDateTime } from '../../format/date';
import type { Order } from './queries';

type Cancellation = NonNullable<Order['cancellation']>;

/** Who cancelled the order, when and why (spec FR-003), for everyone who can read it. */
export function CancellationSection({ cancellation }: { cancellation: Cancellation }) {
  return (
    <section aria-label="Cancellation">
      <h2>Cancellation</h2>
      <p>
        Cancelled by {cancellation.cancelledBy.name} on {formatDateTime(cancellation.cancelledAt)}
      </p>
      <p>Reason: {cancellation.reason}</p>
    </section>
  );
}

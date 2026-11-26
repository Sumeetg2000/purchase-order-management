import { lineNumber } from '@po/contracts';
import { formatDateTime } from '../../format/date';
import type { Order } from './queries';
import { lineReceivedText } from './receipt-progress';

type Cancellation = NonNullable<Order['cancellation']>;

/**
 * Who cancelled the order, when and why, and how much of each line had been received, for
 * everyone who can read it.
 */
export function CancellationSection({
  cancellation,
  lines,
}: {
  cancellation: Cancellation;
  lines: Order['lines'];
}) {
  return (
    <section aria-label="Cancellation">
      <h2>Cancellation</h2>
      <p>
        Cancelled by {cancellation.cancelledBy.name} on {formatDateTime(cancellation.cancelledAt)}
      </p>
      <p>Reason: {cancellation.reason}</p>
      <ul>
        {lines.map((line, position) => (
          <li key={line.id}>
            Line {lineNumber(position)}, {line.description}:{' '}
            {lineReceivedText(line.receivedQuantity, line.quantity)}
          </li>
        ))}
      </ul>
    </section>
  );
}

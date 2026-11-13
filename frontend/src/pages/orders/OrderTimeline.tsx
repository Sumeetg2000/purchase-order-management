import { formatInr, MONEY_PATTERN, toMoney, type OrderAuditAction } from '@po/contracts';
import { useParams } from 'react-router';
import { Pager } from '../../components/Pager';
import { formatDateTime } from '../../format/date';
import { ACTING_ROLE_LABELS } from '../../format/roles';
import { useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import { OrderTabs } from './OrderTabs';
import { useOrder, useOrderTimeline } from './queries';
import css from './orders.module.css';

const styles = classes(css, 'timeline', 'hint');

const ACTION_LABELS = {
  PO_CREATED: 'Raised',
  PO_EDITED: 'Edited',
  PO_DRAFT_DELETED: 'Draft deleted',
} as const satisfies Record<OrderAuditAction, string>;

type Item = NonNullable<ReturnType<typeof useOrderTimeline>['data']>['items'][number];

function actorOf({ actor }: Item): string {
  if (actor.type === 'SYSTEM') return 'System';
  const name = actor.name ?? (actor.type === 'OPERATOR' ? 'Operator' : 'Unknown user');
  const facts = [actor.email, actor.role === null ? null : ACTING_ROLE_LABELS[actor.role]];
  const shown = facts.filter((fact) => fact !== null);
  return shown.length === 0 ? name : `${name} (${shown.join(', ')})`;
}

/** An amount from an entry's details in rupees; anything else as it is. */
function rupees(value: unknown): string {
  return typeof value === 'string' && MONEY_PATTERN.test(value)
    ? formatInr(toMoney(value))
    : String(value);
}

/** "Total: ₹0.30 → ₹0.3875" for an edit, "Total: ₹0.30" for a create or a deletion. */
function totalOf({ details }: Item): string | undefined {
  const total = details['total'];
  if (typeof total === 'object' && total !== null && 'before' in total && 'after' in total) {
    return `Total: ${rupees(total.before)} → ${rupees(total.after)}`;
  }
  return total === undefined ? undefined : `Total: ${rupees(total)}`;
}

/**
 * An order's timeline (FR-018): its entries newest first and paged, each with what
 * happened, who did it in what capacity, when, and the total it left.
 */
export function OrderTimeline() {
  const { id = '' } = useParams();
  const {
    params: { page },
    setPage,
  } = useListParams({});
  const poNumber = useOrder(id).data?.poNumber;
  const states = useQueryStates(useOrderTimeline(id, page), {
    loadingLabel: 'Loading the timeline',
    isEmpty: (data) => data.items.length === 0,
    empty: { title: 'No entries yet', description: 'Changes to this order appear here.' },
  });

  return (
    <>
      <title>{`${poNumber ?? 'Order'} timeline · Purchase Orders`}</title>
      <h1>{poNumber ?? 'Order timeline'}</h1>
      <OrderTabs id={id} />
      {states.view ?? (
        <>
          {states.notice}
          <ol aria-label="Order timeline" className={styles.timeline}>
            {states.data.items.map((item) => {
              const total = totalOf(item);
              return (
                <li key={item.id}>
                  <h2>{ACTION_LABELS[item.action]}</h2>
                  <p className={styles.hint}>
                    {actorOf(item)} ·{' '}
                    <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                  </p>
                  {total && <p>{total}</p>}
                </li>
              );
            })}
          </ol>
          <Pager
            page={states.data.page}
            pageSize={states.data.pageSize}
            total={states.data.total}
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}

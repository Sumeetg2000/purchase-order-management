import type { VendorAuditAction, VendorHistoryItem, VendorSnapshot } from '@po/contracts';
import { useParams } from 'react-router';
import { Pager } from '../../components/Pager';
import { formatDateTime } from '../../format/date';
import { ACTING_ROLE_LABELS } from '../../format/roles';
import { useListParams } from '../../hooks/useListParams';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import { formatPaymentTerms } from './payment-terms';
import { useVendor, useVendorHistory } from './queries';
import { VENDOR_STATUS_LABELS } from './status';
import { VendorTabs } from './VendorTabs';
import css from './vendors.module.css';

const styles = classes(css, 'history', 'muted');

const ACTION_LABELS = {
  VENDOR_CREATED: 'Created',
  VENDOR_UPDATED: 'Edited',
  VENDOR_DEACTIVATED: 'Deactivated',
  VENDOR_REACTIVATED: 'Reactivated',
} as const satisfies Record<VendorAuditAction, string>;

/** Each snapshot field, in the order the details show them, as the screens word it. */
const FIELDS: readonly { label: string; show: (vendor: VendorSnapshot) => string }[] = [
  { label: 'Name', show: (v) => v.name },
  { label: 'Contact', show: (v) => v.contactName },
  { label: 'Email', show: (v) => v.contactEmail },
  { label: 'Phone', show: (v) => v.contactPhone ?? 'None' },
  { label: 'Payment terms', show: (v) => formatPaymentTerms(v.paymentTerms) },
  { label: 'Status', show: (v) => VENDOR_STATUS_LABELS[v.status] },
];

/** "Name: Acme Co → Acme Supplies" for each changed field; every value for a create. */
function changesOf({ before, after }: VendorHistoryItem): string[] {
  return FIELDS.flatMap(({ label, show }) => {
    if (before === null) return [`${label}: ${show(after)}`];
    const was = show(before);
    const now = show(after);
    return was === now ? [] : [`${label}: ${was} → ${now}`];
  });
}

function actorOf({ actor }: VendorHistoryItem): string {
  if (actor.type === 'SYSTEM') return 'System';
  const name = actor.name ?? (actor.type === 'OPERATOR' ? 'Operator' : 'Unknown user');
  const facts = [actor.email, actor.role === null ? null : ACTING_ROLE_LABELS[actor.role]];
  const shown = facts.filter((fact) => fact !== null);
  return shown.length === 0 ? name : `${name} (${shown.join(', ')})`;
}

/**
 * A vendor's history (contracts/ui.md; Buyers and Admins): newest first and paged, each
 * entry with what happened, who did it, when, and the fields it changed.
 */
export function VendorHistory() {
  const { id = '' } = useParams();
  const {
    params: { page },
    setPage,
  } = useListParams({});
  const name = useVendor(id).data?.name;
  const states = useQueryStates(useVendorHistory(id, page), {
    loadingLabel: 'Loading the history',
    isEmpty: (data) => data.items.length === 0,
    empty: { title: 'No history yet', description: 'Changes to this vendor appear here.' },
  });

  return (
    <>
      <title>{`${name ?? 'Vendor'} history · Purchase Orders`}</title>
      <h1>{name ?? 'Vendor history'}</h1>
      <VendorTabs id={id} />
      {states.view ?? (
        <>
          {states.notice}
          <ol aria-label="Vendor history" className={styles.history}>
            {states.data.items.map((item) => {
              const changes = changesOf(item);
              return (
                <li key={item.id}>
                  <h2>{ACTION_LABELS[item.action]}</h2>
                  <p className={styles.muted}>
                    {actorOf(item)} ·{' '}
                    <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                  </p>
                  {changes.length === 0 ? (
                    // A save of the form as it was: recorded, but nothing to compare.
                    <p>No fields changed.</p>
                  ) : (
                    <ul aria-label="Changes">
                      {changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  )}
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

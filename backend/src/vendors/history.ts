import {
  ACTING_ROLES,
  AUDIT_ACTOR_TYPES,
  VENDOR_AUDIT_ACTIONS,
  vendorSnapshot,
  type VendorHistoryItem,
} from '@po/contracts';
import { z } from 'zod';
import type { EntityHistoryRow } from '../audit/repository.js';

// A vendor's audit entry as its history shows it (research R10). Every vendor event's
// details are { before, after } snapshots; an entry the code can't map means code and
// data disagree, which fails loudly rather than showing a guess.

const vendorDetails = z.object({ before: vendorSnapshot.nullable(), after: vendorSnapshot });

function known<const T extends string>(
  row: EntityHistoryRow,
  value: string | null,
  values: readonly T[],
  what: string,
): T | null {
  if (value === null) return null;
  const found = values.find((candidate) => candidate === value);
  if (!found) throw new Error(`Audit entry ${row.id} has ${what} ${value} the code doesn't know`);
  return found;
}

export function toHistoryItem(row: EntityHistoryRow): VendorHistoryItem {
  const action = known(row, row.action, VENDOR_AUDIT_ACTIONS, 'action');
  const type = known(row, row.actorType, AUDIT_ACTOR_TYPES, 'actor type');
  if (!action || !type) throw new Error(`Audit entry ${row.id} has no action or actor type`);
  const { before, after } = vendorDetails.parse(row.details);
  return {
    id: row.id,
    action,
    occurredAt: row.occurredAt.toISOString(),
    actor: {
      type,
      name: row.actorName,
      email: row.actorEmail,
      role: known(row, row.actingRole, ACTING_ROLES, 'acting role'),
    },
    before,
    after,
  };
}

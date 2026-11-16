import type { FieldError, Money } from '@po/contracts';

// The edit's line diff (research R6, ADR-0009). An edit sends the full intended line set in
// display order: a line with an id updates that stored line, one without is added, and a
// stored line left out is removed. A line's position is its index. Pure, so it is
// property-tested, and the service turns it into at most one INSERT, one UPDATE and one
// DELETE whatever the line count.

export interface LineFields {
  description: string;
  quantity: number;
  unitPrice: Money;
}

/** A stored line; the array is in position order, so a line's position is its index. */
export interface StoredLine extends LineFields {
  id: string;
}

export interface IntendedLine extends LineFields {
  id?: string | undefined;
}

export interface PositionedLine extends LineFields {
  position: number;
}

export interface LineChange {
  id: string;
  before: PositionedLine;
  after: PositionedLine;
}

export type LineDiff =
  | {
      ok: true;
      added: PositionedLine[];
      changed: LineChange[];
      removed: (StoredLine & { position: number })[];
    }
  | { ok: false; errors: FieldError[] };

function sameLine(a: PositionedLine, b: PositionedLine): boolean {
  return (
    a.position === b.position &&
    a.description === b.description &&
    a.quantity === b.quantity &&
    a.unitPrice === b.unitPrice
  );
}

/**
 * The diff from `stored` to `intended`, or the field errors of the ids that can't be
 * applied: an id not among the stored lines is LINE_NOT_FOUND, an id used twice is
 * DUPLICATE_LINE_ID at its second use. An unchanged line (same fields, same position) is
 * in no list, so an identical set is an empty diff.
 */
export function diffLines(
  stored: readonly StoredLine[],
  intended: readonly IntendedLine[],
): LineDiff {
  const before = new Map(stored.map((line, position) => [line.id, { ...line, position }]));
  const seen = new Set<string>();
  const errors: FieldError[] = [];
  const added: PositionedLine[] = [];
  const changed: LineChange[] = [];

  intended.forEach(({ id, description, quantity, unitPrice }, position) => {
    const after = { position, description, quantity, unitPrice };
    if (id === undefined) {
      added.push(after);
      return;
    }
    if (seen.has(id)) {
      errors.push({ path: `body.lines.${String(position)}.id`, code: 'DUPLICATE_LINE_ID' });
      return;
    }
    seen.add(id);
    const old = before.get(id);
    if (!old) {
      errors.push({ path: `body.lines.${String(position)}.id`, code: 'LINE_NOT_FOUND' });
      return;
    }
    const was = {
      position: old.position,
      description: old.description,
      quantity: old.quantity,
      unitPrice: old.unitPrice,
    };
    if (!sameLine(was, after)) changed.push({ id, before: was, after });
  });

  if (errors.length > 0) return { ok: false, errors };
  const removed = [...before.values()].filter((line) => !seen.has(line.id));
  return { ok: true, added, changed, removed };
}

import { toMoney, type Money } from '@po/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines, type IntendedLine, type StoredLine } from '../../src/orders/line-diff.js';

// The edit's line diff (research R6, ADR-0009): the intended line set, in display order,
// against the stored one. Lines with an id are updated, lines without one added, lines
// left out removed; a line's position is its index. Fixed seed, so a failure replays.
const RUNS = { seed: 20261113, numRuns: 500 };

const ids = Array.from(
  { length: 40 },
  (_, i) => `0192f0c4-0000-7000-8000-${String(i).padStart(12, '0')}`,
);

const fields = fc.record({
  description: fc.constantFrom('Bolts', 'Washers', 'Nuts', 'Screws'),
  quantity: fc.integer({ min: 1, max: 5 }),
  unitPrice: fc.constantFrom('0.1000', '1.0000', '2.5000').map((p) => toMoney(p)),
});

/** A stored order of 1 to 20 lines, in position order. */
const stored = fc
  .array(fields, { minLength: 1, maxLength: 20 })
  .map((lines): StoredLine[] => lines.map((l, i) => ({ id: ids[i] ?? '', ...l })));

/** A stored order and an intended set: some kept (maybe edited, reordered), some new. */
const scenario = stored.chain((before) =>
  fc
    .tuple(
      fc.shuffledSubarray(before),
      fc.array(fc.option(fields, { nil: undefined }), { maxLength: before.length }),
      fc.array(fields, { maxLength: 5 }),
      fc.array(fc.nat(), { maxLength: 5 }),
    )
    .map(([kept, edits, added, slots]) => {
      const intended: IntendedLine[] = kept.map((line, i) => ({ ...line, ...(edits[i] ?? {}) }));
      added.forEach((line, i) => {
        intended.splice((slots[i] ?? 0) % (intended.length + 1), 0, line);
      });
      return { before, intended };
    })
    .filter(({ intended }) => intended.length > 0),
);

/** Applies a diff to the stored lines: what the three statements leave, in position order. */
function apply(
  before: readonly StoredLine[],
  diff: Extract<ReturnType<typeof diffLines>, { ok: true }>,
) {
  const removed = new Set(diff.removed.map((l) => l.id));
  const rows = new Map(
    before
      .filter((l) => !removed.has(l.id))
      .map((l) => [l.id, { ...l, position: before.indexOf(l) }] as const),
  );
  for (const change of diff.changed) rows.set(change.id, { ...change.after, id: change.id });
  const all = [...rows.values(), ...diff.added.map((l) => ({ id: undefined, ...l }))];
  return all
    .sort((a, b) => a.position - b.position)
    .map(({ description, quantity, unitPrice, id }) => ({ id, description, quantity, unitPrice }));
}

const same = (a: { description: string; quantity: number; unitPrice: Money }, b: typeof a) =>
  a.description === b.description && a.quantity === b.quantity && a.unitPrice === b.unitPrice;

describe('[FR-PO-06] the line diff', () => {
  it('[FR-PO-06] applying the diff gives exactly the intended lines, in order', () => {
    fc.assert(
      fc.property(scenario, ({ before, intended }) => {
        const result = diffLines(before, intended);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(apply(before, result)).toEqual(
          intended.map(({ id, description, quantity, unitPrice }) => ({
            id,
            description,
            quantity,
            unitPrice,
          })),
        );
      }),
      RUNS,
    );
  });

  it('[FR-PO-06] a kept line that is neither edited nor moved is never in changed', () => {
    fc.assert(
      fc.property(scenario, ({ before, intended }) => {
        const result = diffLines(before, intended);
        if (!result.ok) return;
        for (const change of result.changed) {
          const old = before.find((l) => l.id === change.id);
          const index = intended.findIndex((l) => l.id === change.id);
          expect(old && same(old, change.after) && before.indexOf(old) === index).toBe(false);
        }
        expect(result.changed.length + result.added.length + result.removed.length > 0).toBe(
          before.length !== intended.length ||
            intended.some((l, i) => l.id !== before[i]?.id || !same(l, before[i] as StoredLine)),
        );
      }),
      RUNS,
    );
  });

  it('[FR-PO-06] an identical set yields nothing; a moved line changes its position only', () => {
    const before = fc.sample(stored, { seed: 7, numRuns: 1 })[0] ?? [];
    expect(diffLines(before, before)).toEqual({ ok: true, added: [], changed: [], removed: [] });
    const lines: StoredLine[] = [
      { id: ids[0] ?? '', description: 'A', quantity: 1, unitPrice: toMoney('1') },
      { id: ids[1] ?? '', description: 'B', quantity: 2, unitPrice: toMoney('2') },
    ];
    const result = diffLines(lines, [lines[1] as StoredLine, lines[0] as StoredLine]);
    expect(result).toMatchObject({ ok: true, added: [], removed: [] });
    if (!result.ok) return;
    expect(result.changed.map((c) => [c.id, c.before.position, c.after.position])).toEqual([
      [ids[1], 1, 0],
      [ids[0], 0, 1],
    ]);
  });

  it('[NFR-VAL-01] an id not on the order is LINE_NOT_FOUND; a repeated id DUPLICATE_LINE_ID at the repeat', () => {
    const lines: StoredLine[] = [
      { id: ids[0] ?? '', description: 'A', quantity: 1, unitPrice: toMoney('1') },
    ];
    const foreign = ids[39] ?? '';
    expect(
      diffLines(lines, [lines[0] as StoredLine, { ...(lines[0] as StoredLine), id: foreign }]),
    ).toEqual({
      ok: false,
      errors: [{ path: 'body.lines.1.id', code: 'LINE_NOT_FOUND' }],
    });
    expect(
      diffLines(lines, [
        lines[0] as StoredLine,
        { description: 'B', quantity: 1, unitPrice: toMoney('1') },
        lines[0] as StoredLine,
      ]),
    ).toEqual({ ok: false, errors: [{ path: 'body.lines.2.id', code: 'DUPLICATE_LINE_ID' }] });
  });
});

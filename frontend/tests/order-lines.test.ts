import { describe, expect, it } from 'vitest';
import { lineErrors, orderTotals, type LineDraft } from '../src/pages/orders/lines';

function line(key: number, quantity: string, unitPrice: string, description = 'Part'): LineDraft {
  return { key, description, quantity, unitPrice };
}

describe('the editor lines', () => {
  it('a valid line has no errors, and every valid line shares the one empty result', () => {
    const a = lineErrors(line(1, '2', '1.5'));
    const b = lineErrors(line(2, '3', '4'));
    expect(a).toEqual({});
    expect(a).toBe(b);
    expect(lineErrors(line(3, '0', '1'))).toHaveProperty('quantity');
  });

  it('the order total follows every edit, and reuses its sum while no line total changes', () => {
    const totalOf = orderTotals();
    const lines = [line(1, '2', '1.5'), line(2, '3', '0.1'), line(3, '', '9')];
    const first = totalOf(lines);
    expect(first).toBe('3.3000');

    // A description edit replaces the line object but not its total.
    const renamed = lines.map((l, i) => (i === 0 ? { ...l, description: 'Other' } : l));
    expect(totalOf(renamed)).toBe(first);

    const repriced = renamed.map((l, i) => (i === 1 ? { ...l, unitPrice: '0.2' } : l));
    expect(totalOf(repriced)).toBe('3.6000');
    const completed = repriced.map((l, i) => (i === 2 ? { ...l, quantity: '1' } : l));
    expect(totalOf(completed)).toBe('12.6000');
    expect(totalOf(completed.slice(1))).toBe('9.6000');
    expect(totalOf([])).toBe('0.0000');
  });
});

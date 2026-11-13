import {
  createOrderBody,
  fieldErrors,
  formatInr,
  lineTotal,
  LINE_QUANTITY_MAX,
  sum,
  toMoney,
  UNIT_PRICE_INPUT_PATTERN,
  type FieldCode,
  type Money,
} from '@po/contracts';

// The editor's lines (contracts/ui.md): what the user typed, as text, and what follows from
// it. Amounts stay decimal strings through money.ts (ADR-0010): a price is never a number.

export interface LineDraft {
  /** Stable across moves and removals, for React keys and focus. */
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
}

export type LineField = 'description' | 'quantity' | 'unitPrice';
export type LineErrors = Partial<Record<LineField, FieldCode>>;

const WHOLE = /^\d+$/;

/** A whole quantity is sent as a number (a count, not money); anything else as typed. */
function quantityOf(text: string): number | string {
  const trimmed = text.trim();
  return WHOLE.test(trimmed) && trimmed.length <= 16 ? Number(trimmed) : trimmed;
}

/** The line as the API takes it: the price exactly as typed, a string. */
export function lineBodyOf(line: LineDraft) {
  return {
    description: line.description,
    quantity: quantityOf(line.quantity),
    unitPrice: line.unitPrice,
  };
}

const lineSchema = createOrderBody.shape.lines.element;

/** Each field's code from the contract's own rule for a line (row-level validation). */
export function lineErrors(line: LineDraft): LineErrors {
  const result = lineSchema.safeParse(lineBodyOf(line), { reportInput: true });
  if (result.success) return {};
  const errors: LineErrors = {};
  for (const { path, code } of fieldErrors('line', result.error.issues)) {
    const field = path.split('.')[1];
    if (field === 'description' || field === 'quantity' || field === 'unitPrice') {
      errors[field] ??= code;
    }
  }
  return errors;
}

/** The line's exact total, or undefined while its quantity or price isn't valid yet. */
export function lineTotalOf(line: LineDraft): Money | undefined {
  const quantity = quantityOf(line.quantity);
  if (typeof quantity !== 'number' || quantity < 1 || quantity > LINE_QUANTITY_MAX)
    return undefined;
  if (!UNIT_PRICE_INPUT_PATTERN.test(line.unitPrice)) return undefined;
  return lineTotal(quantity, toMoney(line.unitPrice));
}

/** The exact sum of the lines that have a total so far. */
export function orderTotalOf(lines: readonly LineDraft[]): Money {
  return sum(lines.map(lineTotalOf).filter((total): total is Money => total !== undefined));
}

export function rupees(value: Money | undefined): string {
  return value === undefined ? '—' : formatInr(value);
}

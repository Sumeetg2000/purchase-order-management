import type { PaymentTerms, PaymentTermType } from '@po/contracts';

// Payment terms in words (specs/003-vendors/contracts/ui.md).

/** The name of each term type, as the form's choices show it. */
export const PAYMENT_TERM_LABELS = {
  NET: 'Net',
  ADVANCE: 'Advance',
  PARTIAL_ADVANCE: 'Partial advance',
} as const satisfies Record<PaymentTermType, string>;

/** "Net 30", "Advance", or "30 % advance, balance net 45". */
export function formatPaymentTerms(terms: PaymentTerms): string {
  switch (terms.type) {
    case 'NET':
      return `Net ${String(terms.netDays)}`;
    case 'ADVANCE':
      return 'Advance';
    case 'PARTIAL_ADVANCE':
      return `${String(terms.advancePercent)} % advance, balance net ${String(terms.netDays)}`;
  }
}

import type { AdminUserDetail } from '@po/contracts';

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** The user's open orders, as the role and deactivate dialogs state them (ADR-0018). */
export function openOrdersSentence({ openOrders }: AdminUserDetail): string {
  return (
    `Open orders: ${plural(openOrders.draft, 'draft', 'drafts')}, ` +
    `${String(openOrders.pending)} pending, ` +
    `${String(openOrders.approvedWithOpenLines)} approved with lines to receive.`
  );
}

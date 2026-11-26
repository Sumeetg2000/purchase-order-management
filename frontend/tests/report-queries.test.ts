import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ORDERS_KEY } from '../src/pages/orders/queries';
import { OUTSTANDING_KEY } from '../src/pages/reports/queries';

// The report's cached pages go stale whenever an order action refreshes the order lists
// (a save, a receipt, an approval, a cancel all invalidate [...ORDERS_KEY, 'list']), so a
// fully received or cancelled order never lingers in it.

describe('[FR-RPT-01] the outstanding report cache', () => {
  it('[FR-RPT-01] refreshing the order lists marks the report and its vendor summary stale', async () => {
    const client = new QueryClient();
    const report = [...OUTSTANDING_KEY, 'orders', {}];
    const vendors = [...OUTSTANDING_KEY, 'vendors', {}];
    client.setQueryData(report, { items: [] });
    client.setQueryData(vendors, { items: [] });
    await client.invalidateQueries({ queryKey: [...ORDERS_KEY, 'list'] });
    expect(client.getQueryState(report)?.isInvalidated).toBe(true);
    expect(client.getQueryState(vendors)?.isInvalidated).toBe(true);
  });
});

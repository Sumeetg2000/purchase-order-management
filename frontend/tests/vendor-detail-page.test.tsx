import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID, vendor } from './support/vendors';

// The vendor detail page's status actions (specs/003-vendors/contracts/ui.md; spec US3):
// Buyers deactivate through a dialog and reactivate without one; other roles see none.

afterEach(() => {
  vi.unstubAllGlobals();
});

const REACTIVATE = `POST /vendors/${ACME_ID}/reactivate`;
const INACTIVE = { status: 'INACTIVE', deactivatedAt: '2026-11-10T09:00:00.000Z' };

function detailApi(
  roles: readonly string[],
  status: 'ACTIVE' | 'INACTIVE',
  handlers: Record<string, Handler> = {},
) {
  let current = vendor(status === 'INACTIVE' ? INACTIVE : {});
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    [`GET /vendors/${ACME_ID}`]: () => json(200, current, { ETag: `"${String(current.version)}"` }),
    [REACTIVATE]: () => {
      current = vendor({ version: 2 });
      return json(200, current, { ETag: '"2"' });
    },
    ...handlers,
  });
}

/** The page header: the name, the status badge and the actions. */
async function header(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' });
  if (!heading.parentElement) throw new Error('the heading has no header around it');
  return heading.parentElement;
}

describe('[FR-VEN-01] vendor detail status actions', () => {
  it('[FR-VEN-01] a Buyer sees Edit and Deactivate on an active vendor', async () => {
    detailApi(['BUYER'], 'ACTIVE');
    renderApp(`/vendors/${ACME_ID}`);
    const top = await header();
    expect(within(top).getByText('Active')).toBeInTheDocument();
    expect(within(top).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(within(top).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(top).queryByRole('button', { name: 'Reactivate' })).toBeNull();
  });

  it('[FR-VEN-01] a Buyer reactivates an inactive vendor with no dialog, sending If-Match', async () => {
    const seen = detailApi(['BUYER'], 'INACTIVE');
    const { user } = renderApp(`/vendors/${ACME_ID}`);
    const top = await header();
    expect(within(top).getByText('Inactive')).toBeInTheDocument();
    expect(within(top).queryByRole('button', { name: 'Deactivate' })).toBeNull();

    await user.click(within(top).getByRole('button', { name: 'Reactivate' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await within(top).findByText('Active')).toBeInTheDocument();
    expect(within(top).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    const [request] = seen.filter((r) => r.method === 'POST');
    expect(request?.headers.get('If-Match')).toBe('"1"');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-VEN-01] Reactivate is disabled while its request is pending', async () => {
    let finish: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen = detailApi(['BUYER'], 'INACTIVE', {
      [REACTIVATE]: async () => {
        await answered;
        return json(200, vendor({ version: 2 }), { ETag: '"2"' });
      },
    });
    const { user } = renderApp(`/vendors/${ACME_ID}`);
    const top = await header();
    await user.click(within(top).getByRole('button', { name: 'Reactivate' }));
    expect(within(top).getByRole('button', { name: /Reactivat/ })).toBeDisabled();
    await user.click(within(top).getByRole('button', { name: /Reactivat/ }));
    finish();
    await waitFor(() => {
      expect(within(top).getByText('Active')).toBeInTheDocument();
    });
    expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('[FR-VEN-01] a failed reactivate is shown on the page with Reload', async () => {
    const seen = detailApi(['BUYER'], 'INACTIVE', {
      [REACTIVATE]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user } = renderApp(`/vendors/${ACME_ID}`);
    const top = await header();
    await user.click(within(top).getByRole('button', { name: 'Reactivate' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(errorMessages.VERSION_CONFLICT.message);
    const reads = () => seen.filter((r) => r.method === 'GET' && r.url.includes('/vendors/'));
    const before = reads().length;
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(reads().length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('[FR-VEN-01] an Approver sees the status but no Edit, Deactivate or Reactivate', async () => {
    detailApi(['APPROVER'], 'INACTIVE');
    renderApp(`/vendors/${ACME_ID}`);
    const top = await header();
    expect(within(top).getByText('Inactive')).toBeInTheDocument();
    expect(within(top).queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(within(top).queryByRole('button')).toBeNull();
  });
});

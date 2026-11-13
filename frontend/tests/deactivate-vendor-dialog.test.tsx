import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID, vendor } from './support/vendors';

// The Deactivate dialog on the vendor detail page (specs/003-vendors/contracts/ui.md;
// spec US3): it names the vendor and the consequence, starts on the safe button, and
// shows a server error inside itself.

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEACTIVATE = `POST /vendors/${ACME_ID}/deactivate`;

/** The vendor as GET returns it; each deactivate that succeeds makes it INACTIVE. */
function dialogApi(handlers: Record<string, Handler> = {}) {
  let current = vendor();
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles: ['BUYER'] }),
    [`GET /vendors/${ACME_ID}`]: () => json(200, current, { ETag: `"${String(current.version)}"` }),
    // The caller's drafts with this vendor (slice 3): none unless a test says otherwise.
    'GET /orders': () => json(200, { items: [], page: 1, pageSize: 1, total: 0 }),
    [DEACTIVATE]: () => {
      current = vendor({
        status: 'INACTIVE',
        deactivatedAt: '2026-11-11T09:00:00.000Z',
        version: 2,
      });
      return json(200, current, { ETag: '"2"' });
    },
    ...handlers,
  });
}

async function openDialog() {
  const view = renderApp(`/vendors/${ACME_ID}`);
  await view.user.click(await screen.findByRole('button', { name: 'Deactivate' }));
  const dialog = await screen.findByRole('alertdialog');
  return { ...view, dialog };
}

const posts = (seen: Request[]) => seen.filter((r) => r.method === 'POST');

describe('[FR-VEN-02] the draft count in the deactivate dialog', () => {
  it("[FR-VEN-02] says how many of the caller's drafts use the vendor, read through the order list", async () => {
    const seen = dialogApi({
      'GET /orders': () => json(200, { items: [], page: 1, pageSize: 1, total: 3 }),
    });
    const { dialog } = await openDialog();
    expect(
      await within(dialog).findByText('3 of your draft orders use this vendor.'),
    ).toBeVisible();
    const list = seen.find(
      (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/orders'),
    );
    const query = new URL(list?.url ?? 'http://x').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      vendorId: ACME_ID,
      status: 'DRAFT',
      pageSize: '1',
    });
  });

  it('[FR-VEN-02] says one draft in the singular, and nothing at none', async () => {
    dialogApi({ 'GET /orders': () => json(200, { items: [], page: 1, pageSize: 1, total: 1 }) });
    const { dialog } = await openDialog();
    expect(
      await within(dialog).findByText('1 of your draft orders uses this vendor.'),
    ).toBeVisible();
  });

  it("[FR-VEN-02] a count that can't be read is said, and doesn't block deactivating", async () => {
    dialogApi({ 'GET /orders': () => problem(500, 'INTERNAL_ERROR') });
    const { dialog } = await openDialog();
    expect(await within(dialog).findByText("Couldn't load your draft count.")).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Deactivate vendor' })).toBeEnabled();
  });
});

describe('[FR-VEN-01] deactivate vendor dialog', () => {
  it('[FR-VEN-01] names the vendor and the consequence, with focus on "Keep active"', async () => {
    dialogApi();
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Deactivate Acme Supplies?');
    expect(dialog).toHaveAccessibleDescription(
      "Orders using it can't be submitted or approved until it's reactivated.",
    );
    expect(within(dialog).getByRole('button', { name: 'Keep active' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Deactivate vendor' })).toBeEnabled();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-VEN-01] Escape and "Keep active" close it without a request', async () => {
    const seen = dialogApi();
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(await screen.findByRole('button', { name: 'Keep active' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(seen)).toEqual([]);
  });

  it('[FR-VEN-01] confirming sends If-Match, is disabled while pending, then shows the vendor inactive', async () => {
    let finish: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen = dialogApi({
      [DEACTIVATE]: async () => {
        await answered;
        return json(200, vendor({ status: 'INACTIVE', version: 2 }), { ETag: '"2"' });
      },
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate vendor' }));
    expect(within(dialog).getByRole('button', { name: /Deactivate vendor/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Keep active' })).toBeDisabled();

    finish();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const [request] = posts(seen);
    expect(request?.headers.get('If-Match')).toBe('"1"');
    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('[FR-VEN-01] a server error shows inside the dialog, with Reload for a changed status', async () => {
    const seen = dialogApi({ [DEACTIVATE]: () => problem(409, 'INVALID_STATE_TRANSITION') });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate vendor' }));

    expect(
      await within(dialog).findByText(errorMessages.INVALID_STATE_TRANSITION.message, {
        exact: false,
      }),
    ).toBeInTheDocument();
    const reads = () =>
      seen.filter((r) => r.method === 'GET' && r.url.endsWith(`/vendors/${ACME_ID}`)).length;
    const before = reads();
    await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(before);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[FR-VEN-01] a version conflict also offers Reload', async () => {
    dialogApi({ [DEACTIVATE]: () => problem(409, 'VERSION_CONFLICT') });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate vendor' }));
    expect(await within(dialog).findByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

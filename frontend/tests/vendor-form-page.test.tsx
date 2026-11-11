import { API_PATH_PREFIX } from '@po/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages, fieldMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID, vendor } from './support/vendors';

// Adding a vendor (specs/003-vendors/contracts/ui.md; spec US1): fields for the chosen
// payment-term type only, field errors by code, the duplicate link, no double submit.

afterEach(() => {
  vi.unstubAllGlobals();
});

function formApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles: ['BUYER'] }),
    [`GET /vendors/${ACME_ID}`]: () => json(200, vendor(), { ETag: '"1"' }),
    'POST /vendors': () =>
      json(201, vendor(), { ETag: '"1"', Location: `${API_PATH_PREFIX}/vendors/${ACME_ID}` }),
    ...handlers,
  });
}

async function fillRequired(user: ReturnType<typeof renderApp>['user']) {
  await user.type(await screen.findByLabelText('Vendor name'), 'Acme Supplies');
  await user.type(screen.getByLabelText('Contact name'), 'Ravi Shah');
  await user.type(screen.getByLabelText('Contact email'), 'Ravi@Acme.example');
  await user.type(screen.getByLabelText('Net days'), '30');
}

const posted = async (seen: Request[]) => {
  const request = seen.find((r) => r.method === 'POST');
  return request ? ((await request.json()) as unknown) : undefined;
};

describe('[FR-VEN-01] add vendor form', () => {
  it('[FR-VEN-01] shows the fields of the chosen payment-term type only', async () => {
    formApi();
    const { user } = renderApp('/vendors/new');
    expect(await screen.findByRole('heading', { level: 1, name: 'Add vendor' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Net' })).toBeChecked();
    expect(screen.getByLabelText('Net days')).toBeInTheDocument();
    expect(screen.queryByLabelText('Advance percent')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Partial advance' }));
    expect(screen.getByLabelText('Advance percent')).toBeInTheDocument();
    expect(screen.getByLabelText('Net days')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Advance' }));
    expect(screen.queryByLabelText('Advance percent')).toBeNull();
    expect(screen.queryByLabelText('Net days')).toBeNull();
  });

  it('[FR-VEN-01] adds a vendor with no phone and opens it', async () => {
    const seen = formApi();
    const { user, router } = renderApp('/vendors/new');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add vendor' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/vendors/${ACME_ID}`);
    });
    expect(await posted(seen)).toEqual({
      name: 'Acme Supplies',
      contactName: 'Ravi Shah',
      contactEmail: 'Ravi@Acme.example',
      contactPhone: null,
      paymentTerms: { type: 'NET', netDays: 30 },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' }),
    ).toBeInTheDocument();
  });

  it('[FR-VEN-01] sends partial-advance terms and a phone', async () => {
    const seen = formApi();
    const { user } = renderApp('/vendors/new');
    await user.type(await screen.findByLabelText('Vendor name'), 'Partial Co');
    await user.type(screen.getByLabelText('Contact name'), 'Mei Lin');
    await user.type(screen.getByLabelText('Contact email'), 'mei@partial.example');
    await user.type(screen.getByLabelText('Contact phone (optional)'), '+91 22 4000 1000');
    await user.click(screen.getByRole('radio', { name: 'Partial advance' }));
    await user.type(screen.getByLabelText('Advance percent'), '30');
    await user.type(screen.getByLabelText('Net days'), '45');
    await user.click(screen.getByRole('button', { name: 'Add vendor' }));
    await waitFor(async () => {
      expect(await posted(seen)).toMatchObject({
        contactPhone: '+91 22 4000 1000',
        paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 30, netDays: 45 },
      });
    });
  });

  it('[FR-VEN-01] shows each field error by its code, next to its field', async () => {
    formApi({
      'POST /vendors': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [
            { path: 'body.contactEmail', code: 'INVALID_FORMAT' },
            { path: 'body.paymentTerms.netDays', code: 'OUT_OF_RANGE' },
          ],
        }),
    });
    const { user } = renderApp('/vendors/new');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add vendor' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contact email')).toHaveAccessibleDescription(
        fieldMessages.INVALID_FORMAT,
      );
    });
    expect(screen.getByLabelText('Net days')).toHaveAccessibleDescription(
      fieldMessages.OUT_OF_RANGE,
    );
    expect(screen.getByLabelText('Vendor name')).not.toHaveAccessibleDescription();
  });

  it('[FR-VEN-01] a duplicate name links to the existing vendor', async () => {
    formApi({
      'POST /vendors': () =>
        problem(409, 'DUPLICATE_VENDOR_NAME', {
          existingVendor: { id: ACME_ID, name: 'Acme Supplies' },
        }),
    });
    const { user } = renderApp('/vendors/new');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add vendor' }));
    expect(await screen.findByRole('link', { name: 'Open Acme Supplies' })).toHaveAttribute(
      'href',
      `/vendors/${ACME_ID}`,
    );
    expect(screen.getByLabelText('Vendor name')).toHaveAccessibleDescription(
      errorMessages.DUPLICATE_VENDOR_NAME.message,
    );
  });

  it('[FR-VEN-01] another failure is shown above the button', async () => {
    formApi({ 'POST /vendors': () => problem(403, 'FORBIDDEN') });
    const { user } = renderApp('/vendors/new');
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add vendor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(errorMessages.FORBIDDEN.message);
  });

  it('[FR-VEN-01] sends one request however often the button is pressed', async () => {
    let answer: (response: Response) => void = () => undefined;
    const seen = formApi({
      'POST /vendors': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const { user } = renderApp('/vendors/new');
    await fillRequired(user);
    const button = screen.getByRole('button', { name: 'Add vendor' });
    await user.click(button);
    await user.click(button);
    expect(button).toBeDisabled();
    answer(json(201, vendor(), { ETag: '"1"' }));
    await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' });
    expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('[SC-007] the form has no axe violations', async () => {
    formApi();
    renderApp('/vendors/new');
    await screen.findByLabelText('Vendor name');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[FR-VEN-01] edit vendor form', () => {
  const EDIT_PATH = `/vendors/${ACME_ID}/edit`;
  const current = vendor({
    contactPhone: '022 4000 1000',
    paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 45 },
  });

  function editApi(handlers: Record<string, Handler> = {}) {
    return formApi({
      [`GET /vendors/${ACME_ID}`]: () => json(200, current, { ETag: '"1"' }),
      [`PUT /vendors/${ACME_ID}`]: async (request) =>
        json(
          200,
          { ...current, ...((await request.json()) as object), version: 2 },
          {
            ETag: '"2"',
          },
        ),
      ...handlers,
    });
  }

  const put = (seen: Request[]) => seen.filter((r) => r.method === 'PUT');

  it('[FR-ACT-01] a role removed mid-edit: the next save shows the 403 message and keeps the edits', async () => {
    editApi({ [`PUT /vendors/${ACME_ID}`]: () => problem(403, 'FORBIDDEN') });
    const { user } = renderApp(EDIT_PATH);
    const name = await screen.findByLabelText('Vendor name');
    await user.clear(name);
    await user.type(name, 'Acme Industrial');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(errorMessages.FORBIDDEN.message);
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByLabelText('Vendor name')).toHaveValue('Acme Industrial');
  });

  it('[FR-VEN-01] is prefilled with the vendor', async () => {
    editApi();
    renderApp(EDIT_PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit vendor' })).toBeVisible();
    expect(await screen.findByLabelText('Vendor name')).toHaveValue('Acme Supplies');
    expect(screen.getByLabelText('Contact name')).toHaveValue('Ravi Shah');
    expect(screen.getByLabelText('Contact email')).toHaveValue('ravi@acme.example');
    expect(screen.getByLabelText('Contact phone (optional)')).toHaveValue('022 4000 1000');
    expect(screen.getByRole('radio', { name: 'Partial advance' })).toBeChecked();
    expect(screen.getByLabelText('Advance percent')).toHaveValue('20');
    expect(screen.getByLabelText('Net days')).toHaveValue('45');
  });

  it('[FR-VEN-01] saves with If-Match and no confirmation; a cleared phone is sent as null', async () => {
    const seen = editApi();
    const { user, router } = renderApp(EDIT_PATH);
    await user.clear(await screen.findByLabelText('Contact phone (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/vendors/${ACME_ID}`);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const [request] = put(seen);
    expect(request?.headers.get('If-Match')).toBe('"1"');
    expect(await request?.json()).toEqual({
      name: 'Acme Supplies',
      contactName: 'Ravi Shah',
      contactEmail: 'ravi@acme.example',
      contactPhone: null,
      paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 45 },
    });
  });

  it('[NFR-FE-09] leaving with unsaved edits asks first; a reload or tab close is guarded', async () => {
    editApi();
    const { user, router } = renderApp(EDIT_PATH);
    await user.type(await screen.findByLabelText('Contact name'), ' Jr');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
      'Discard your unsaved changes?',
    );
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe(EDIT_PATH);
    expect(screen.getByLabelText('Contact name')).toHaveValue('Ravi Shah Jr');
  });

  it('[FR-VEN-01] a version conflict offers Reload, which asks before discarding the edits', async () => {
    let reads = 0;
    const seen = editApi({
      [`GET /vendors/${ACME_ID}`]: () => {
        reads += 1;
        return reads === 1
          ? json(200, current, { ETag: '"1"' })
          : json(200, { ...current, contactName: 'Meera Iyer', version: 3 }, { ETag: '"3"' });
      },
      [`PUT /vendors/${ACME_ID}`]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user } = renderApp(EDIT_PATH);
    await user.type(await screen.findByLabelText('Vendor name'), ' Ltd');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.VERSION_CONFLICT.message,
    );

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
      'Discard your unsaved changes?',
    );
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contact name')).toHaveValue('Meera Iyer');
    });
    expect(screen.getByLabelText('Vendor name')).toHaveValue('Acme Supplies');
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(put(seen)).toHaveLength(2);
    });
    expect(put(seen)[1]?.headers.get('If-Match')).toBe('"3"');
  });

  it('[NFR-FE-09] a background refetch of a newer version keeps the edits and their version', async () => {
    let reads = 0;
    const seen = editApi({
      [`GET /vendors/${ACME_ID}`]: () => {
        reads += 1;
        return reads === 1
          ? json(200, current, { ETag: '"1"' })
          : json(200, { ...current, contactName: 'Meera Iyer', version: 3 }, { ETag: '"3"' });
      },
      [`PUT /vendors/${ACME_ID}`]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user } = renderApp(EDIT_PATH);
    await user.type(await screen.findByLabelText('Vendor name'), ' Ltd');
    // The user switches tabs and comes back: the query refetches on focus.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    focusManager.setFocused(undefined);
    expect(screen.getByLabelText('Vendor name')).toHaveValue('Acme Supplies Ltd');
    expect(screen.getByLabelText('Contact name')).toHaveValue('Ravi Shah');
    // The save still claims the version the edits were made on, so it is refused as stale.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.VERSION_CONFLICT.message,
    );
    expect(put(seen)[0]?.headers.get('If-Match')).toBe('"1"');
  });

  it('[FR-VEN-01] a duplicate name links to the existing vendor', async () => {
    const otherId = '0192e4a0-0000-7000-8000-0000000000b2';
    editApi({
      [`PUT /vendors/${ACME_ID}`]: () =>
        problem(409, 'DUPLICATE_VENDOR_NAME', {
          existingVendor: { id: otherId, name: 'Bolt Traders' },
        }),
    });
    const { user } = renderApp(EDIT_PATH);
    const name = await screen.findByLabelText('Vendor name');
    await user.clear(name);
    await user.type(name, 'bolt traders');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('link', { name: 'Open Bolt Traders' })).toHaveAttribute(
      'href',
      `/vendors/${otherId}`,
    );
  });

  it('[FR-VEN-01] a Buyer opens the edit form from the vendor page', async () => {
    editApi();
    const { user, router } = renderApp(`/vendors/${ACME_ID}`);
    await user.click(await screen.findByRole('link', { name: 'Edit' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(EDIT_PATH);
    });
  });

  it('[SC-007] the edit form has no axe violations', async () => {
    editApi();
    renderApp(EDIT_PATH);
    await screen.findByLabelText('Vendor name');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

import { screen, waitFor } from '@testing-library/react';
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
      json(201, vendor(), { ETag: '"1"', Location: `/api/vendors/${ACME_ID}` }),
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

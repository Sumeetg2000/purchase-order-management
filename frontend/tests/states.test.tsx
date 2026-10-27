import { ERROR_CODES } from '@po/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, ProblemError } from '../src/api/client';
import { Empty } from '../src/components/Empty';
import { ErrorState } from '../src/components/ErrorState';
import { Loading } from '../src/components/Loading';
import { RouteErrorBoundary } from '../src/components/RouteErrorBoundary';
import { errorMessages, RETRYABLE_CODES } from '../src/errors/messages';
import { useQueryStates } from '../src/hooks/useQueryStates';
import { axeViolations } from './support/axe';

const problem = (code: string, correlationId = 'req-state-0001') =>
  new ProblemError({ type: 'about:blank', title: 'x', status: 503, code, correlationId });

describe('[NFR-FE-01] page states', () => {
  it('[NFR-FE-04] Loading is an accessible busy status', async () => {
    render(<Loading label="Loading orders" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading orders');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-FE-04] Empty says what is missing and offers the next step', async () => {
    render(
      <Empty
        title="No orders yet"
        description="Orders you raise appear here."
        action={<button type="button">Raise an order</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No orders yet' })).toBeInTheDocument();
    expect(screen.getByText('Orders you raise appear here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise an order' })).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-FE-01] ErrorState shows the mapped message and the request id', async () => {
    render(<ErrorState problem={{ code: 'NOT_FOUND', correlationId: 'req-state-0002' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(errorMessages.NOT_FOUND.message);
    expect(screen.getByText('req-state-0002')).toBeInTheDocument();
    expect(screen.getByText(/Request ID/)).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it.each(ERROR_CODES.map((code) => [code]))(
    '[NFR-FE-01] ErrorState offers Retry for %s only when it is a temporary failure',
    async (code) => {
      const onRetry = vi.fn();
      render(<ErrorState problem={{ code, correlationId: 'req-state-0003' }} onRetry={onRetry} />);
      const retry = screen.queryByRole('button', { name: 'Retry' });
      if ((RETRYABLE_CODES as readonly string[]).includes(code)) {
        expect(retry).not.toBeNull();
        await userEvent.setup().click(retry as HTMLElement);
        expect(onRetry).toHaveBeenCalledTimes(1);
      } else {
        expect(retry).toBeNull();
      }
    },
  );

  it('[NFR-FE-01] Retry is offered for exactly SERVICE_UNAVAILABLE and CONCURRENCY_RETRY_EXHAUSTED', () => {
    expect([...RETRYABLE_CODES].sort()).toEqual([
      'CONCURRENCY_RETRY_EXHAUSTED',
      'SERVICE_UNAVAILABLE',
    ]);
  });

  it('[NFR-FE-01] an unknown code still gets a message', () => {
    render(<ErrorState problem={{ code: 'SOMETHING_NEW' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(errorMessages.INTERNAL_ERROR.message);
  });

  it('[NFR-FE-01] the error message map has an entry for every registry code, and no others', () => {
    expect(Object.keys(errorMessages).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) expect(errorMessages[code].message.length).toBeGreaterThan(0);
  });
});

describe('[NFR-FE-01] RouteErrorBoundary', () => {
  function routerWith(element: () => never) {
    const Layout = () => (
      <>
        <nav aria-label="Main">
          <Link to="/other">Other page</Link>
        </nav>
        <Outlet />
      </>
    );
    return createMemoryRouter(
      [
        {
          element: <Layout />,
          children: [
            { path: '/', Component: element, errorElement: <RouteErrorBoundary /> },
            { path: '/other', element: <h1>Other page</h1> },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );
  }

  it('[NFR-FE-01] contains a throwing route, shows its request id, and keeps navigation working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RouterProvider
        router={routerWith(() => {
          throw problem('SERVICE_UNAVAILABLE', 'req-boundary-0001');
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.SERVICE_UNAVAILABLE.message,
    );
    expect(screen.getByText('req-boundary-0001')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Other page' }));
    expect(await screen.findByRole('heading', { name: 'Other page' })).toBeInTheDocument();
  });

  it('[NFR-FE-01] for an error that is not a problem, shows the last request id the client saw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: () =>
        Promise.resolve(
          new Response('{"status":"ok"}', {
            headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-last-0001' },
          }),
        ),
    });
    await client.GET('/healthz');
    render(
      <RouterProvider
        router={routerWith(() => {
          throw new Error('render bug');
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.INTERNAL_ERROR.message,
    );
    expect(screen.getByText('req-last-0001')).toBeInTheDocument();
  });
});

describe('[NFR-FE-04] useQueryStates', () => {
  function Orders({ fetcher }: { fetcher: () => Promise<string[]> }) {
    const query = useQuery({ queryKey: ['orders'], queryFn: fetcher, retry: false });
    const { view, data } = useQueryStates(query, {
      loadingLabel: 'Loading orders',
      isEmpty: (orders) => orders.length === 0,
      empty: { title: 'No orders yet', description: 'Orders you raise appear here.' },
    });
    if (view) return view;
    return (
      <ul>
        {data.map((order) => (
          <li key={order}>{order}</li>
        ))}
      </ul>
    );
  }

  const renderWith = (fetcher: () => Promise<string[]>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Orders fetcher={fetcher} />
      </QueryClientProvider>,
    );

  it('[NFR-FE-04] shows loading, then the data', async () => {
    renderWith(() => Promise.resolve(['PO-1', 'PO-2']));
    expect(screen.getByRole('status')).toHaveTextContent('Loading orders');
    expect(await screen.findByText('PO-2')).toBeInTheDocument();
  });

  it('[NFR-FE-04] shows the empty state when there is nothing', async () => {
    renderWith(() => Promise.resolve([]));
    expect(await screen.findByRole('heading', { name: 'No orders yet' })).toBeInTheDocument();
  });

  it('[NFR-FE-04] shows the error with a working Retry for a temporary failure', async () => {
    let calls = 0;
    renderWith(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(problem('SERVICE_UNAVAILABLE'))
        : Promise.resolve(['PO-3']);
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('PO-3')).toBeInTheDocument();
  });
});

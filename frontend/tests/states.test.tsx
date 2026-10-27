import { ERROR_CODES } from '@po/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, dataOrThrow, NetworkError, ProblemError } from '../src/api/client';
import { createQueryClient } from '../src/app/providers';
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

  it('[NFR-FE-01] a plain error shows no request id, never one from an unrelated earlier request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: () =>
        Promise.resolve(
          new Response('{"status":"ok"}', {
            headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-earlier-0001' },
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
    expect(screen.queryByText('req-earlier-0001')).toBeNull();
    expect(screen.queryByText(/Request ID/)).toBeNull();
  });
});

describe('[NFR-FE-04] useQueryStates edge cases', () => {
  function Picker({ enabled }: { enabled: boolean }) {
    const query = useQuery({
      queryKey: ['vendor-orders'],
      queryFn: () => Promise.resolve(['PO-9']),
      enabled,
    });
    const { view, data } = useQueryStates(query, {
      loadingLabel: 'Loading orders',
      idle: <p>Choose a vendor to see its orders.</p>,
    });
    if (view) return view;
    return <p>{data.join(', ')}</p>;
  }

  it('[NFR-FE-04] a query that is not enabled yet shows its idle content, not a spinner', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Picker enabled={false} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Choose a vendor to see its orders.')).toBeInTheDocument();
  });

  it('[NFR-FE-04] a failed background refresh keeps the loaded data and adds a notice with Retry', async () => {
    let calls = 0;
    function Orders() {
      const query = useQuery({
        queryKey: ['orders-refresh'],
        retry: false,
        queryFn: () => {
          calls += 1;
          return calls === 2
            ? Promise.reject(problem('SERVICE_UNAVAILABLE', 'req-refresh-0001'))
            : Promise.resolve([`PO-${String(calls)}`]);
        },
      });
      const { view, data, notice } = useQueryStates(query, { loadingLabel: 'Loading orders' });
      if (view) return view;
      return (
        <>
          {notice}
          <p>{data.join(', ')}</p>
          <button type="button" onClick={() => void query.refetch()}>
            Refresh
          </button>
        </>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Orders />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect(await screen.findByText('PO-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('req-refresh-0001');
    expect(screen.getByText('PO-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('PO-3')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('[NFR-FE-01] an error screen shows its own request id while another request is in flight', async () => {
    // Two overlapping requests: the failing one (a proxy page, not a problem document)
    // finishes first; the successful one finishes afterwards.
    let finishOk = () => undefined as unknown;
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: (request: Request) =>
        request.url.endsWith('/readyz')
          ? Promise.resolve(
              new Response('<html>bad gateway</html>', {
                status: 502,
                headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-fail-0001' },
              }),
            )
          : new Promise<Response>((resolve) => {
              finishOk = () => {
                resolve(
                  new Response('{"status":"ok"}', {
                    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-ok-0001' },
                  }),
                );
              };
            }),
    });
    renderWith(async () => {
      const healthy = client.GET('/healthz');
      const failed = await client.GET('/readyz');
      finishOk();
      await healthy;
      // The error is reported only after the later request has finished.
      dataOrThrow(failed);
      return [];
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('req-fail-0001')).toBeInTheDocument();
    expect(screen.queryByText('req-ok-0001')).toBeNull();
  });

  it('[NFR-FE-04] a network failure is a temporary failure, with Retry', async () => {
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    let calls = 0;
    renderWith(async () => {
      calls += 1;
      if (calls === 1) await client.GET('/healthz');
      return ['PO-4'];
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.SERVICE_UNAVAILABLE.message,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('PO-4')).toBeInTheDocument();
  });

  it('[NFR-FE-04] the app retries network and temporary failures automatically, and nothing else', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry as (
      failures: number,
      error: unknown,
    ) => boolean;
    expect(retry(0, new NetworkError({ cause: new TypeError('Failed to fetch') }))).toBe(true);
    expect(retry(0, problem('SERVICE_UNAVAILABLE'))).toBe(true);
    expect(retry(0, problem('NOT_FOUND'))).toBe(false);
    expect(retry(0, new Error('bug'))).toBe(false);
    expect(retry(5, problem('SERVICE_UNAVAILABLE'))).toBe(false);
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

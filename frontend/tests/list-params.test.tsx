import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { pickOne, TEXT, useListParams } from '../src/hooks/useListParams';

// useListParams: a list's filters and page, read from and written to the URL.

const STATUSES = ['ACTIVE', 'INACTIVE', 'ALL'] as const;

function inRouter(url: string) {
  let router: ReturnType<typeof createMemoryRouter> | undefined;
  const wrapper = ({ children }: { children: ReactNode }) => {
    router ??= createMemoryRouter([{ path: '*', element: children }], { initialEntries: [url] });
    return <RouterProvider router={router} />;
  };
  return { wrapper, search: () => router?.state.location.search };
}

function render(url: string) {
  const { wrapper, search } = inRouter(url);
  const { result } = renderHook(
    () => useListParams({ status: STATUSES, q: TEXT }, { defaults: { status: 'ACTIVE' } }),
    { wrapper },
  );
  return { result, search };
}

describe('[NFR-FE-04] useListParams', () => {
  it('[NFR-FE-04] reads allowed values, trimmed text and the page; anything else is unset', () => {
    expect(render('/?status=ALL&q=%20acm%20&page=3').result.current.params).toEqual({
      status: 'ALL',
      q: 'acm',
      page: 3,
    });
    expect(render('/?status=nope&q=%20&page=-2').result.current.params).toEqual({
      status: undefined,
      q: undefined,
      page: 1,
    });
  });

  it('[NFR-FE-04] show changes a filter from page 1, leaving out defaults', () => {
    const { result, search } = render('/?status=ALL&q=acm&page=3');
    act(() => {
      result.current.show({ status: 'INACTIVE' });
    });
    expect(search()).toBe('?status=INACTIVE&q=acm');
    act(() => {
      result.current.show({ status: 'ACTIVE' });
    });
    expect(search()).toBe('?q=acm');
  });

  it('[NFR-FE-04] two changes before the next render both land: each builds on the URL as it is', () => {
    const { result, search } = render('/?status=ALL');
    // One handler, or a search firing as a filter changes: no render between the two.
    const { show } = result.current;
    act(() => {
      show({ q: 'acm' });
      show({ status: 'INACTIVE' });
    });
    expect(search()).toBe('?status=INACTIVE&q=acm');
  });

  it('[NFR-FE-04] setPage keeps the filters; page 1 is left out', () => {
    const { result, search } = render('/?status=ALL');
    act(() => {
      result.current.setPage(2);
    });
    expect(search()).toBe('?status=ALL&page=2');
    act(() => {
      result.current.setPage(1);
    });
    expect(search()).toBe('?status=ALL');
  });

  it('[NFR-FE-04] pickOne accepts only the allowed values', () => {
    expect(pickOne('ALL', STATUSES)).toBe('ALL');
    expect(pickOne('all', STATUSES)).toBeUndefined();
    expect(pickOne(null, STATUSES)).toBeUndefined();
  });
});

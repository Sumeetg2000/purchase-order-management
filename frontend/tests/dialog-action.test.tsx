import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isVersionConflict, reloadAction, useDialogAction } from '../src/hooks/useDialogAction';
import { problem } from './support/fake-api';

// useDialogAction and reloadAction: a ConfirmDialog's call, refresh and Reload.

function answer(status: number, code?: string) {
  const response = code ? problem(status, code) : new Response(null, { status });
  return async () =>
    code
      ? { error: (await response.clone().json()) as unknown, response }
      : { data: 'done', response };
}

describe('[NFR-FE-09] useDialogAction', () => {
  it('[NFR-FE-09] on success refreshes, then runs done with the data', async () => {
    const order: string[] = [];
    const refresh = vi.fn(() => {
      order.push('refresh');
      return Promise.resolve();
    });
    const { result } = renderHook(() => useDialogAction({ refresh }));
    await act(async () => {
      expect(
        await result.current.run(answer(200), (data) => {
          order.push(`done:${data}`);
        }),
      ).toBe(true);
    });
    expect(order).toEqual(['refresh', 'done:done']);
    expect(result.current.error).toBeUndefined();
  });

  it('[NFR-FE-09] keeps a failure for the dialog, refreshing only when it is stale', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const done = vi.fn();
    const { result } = renderHook(() =>
      useDialogAction({ refresh, isStale: (code) => code === 'NOT_FOUND' }),
    );
    await act(async () => {
      expect(await result.current.run(answer(409, 'VERSION_CONFLICT'), done)).toBe(false);
    });
    expect(result.current.error?.problem.code).toBe('VERSION_CONFLICT');
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.run(answer(404, 'NOT_FOUND'), done);
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeUndefined();
  });

  it('[NFR-FE-09] reloadAction offers Reload only for a stale failure', () => {
    const onReload = vi.fn();
    const failure = (code: string) => ({ problem: { code } });
    expect(reloadAction(undefined, isVersionConflict, onReload)).toEqual([]);
    expect(reloadAction(failure('NOT_FOUND'), isVersionConflict, onReload)).toEqual([]);
    const [reload] = reloadAction(failure('VERSION_CONFLICT'), isVersionConflict, onReload);
    expect(reload?.label).toBe('Reload');
    reload?.onPress();
    expect(onReload).toHaveBeenCalledOnce();
  });
});

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useApiForm } from '../src/hooks/useApiForm';
import { problem } from './support/fake-api';

// useApiForm: pending state, no double submit, and the failure kept for the page.

const ok = <T,>(data: T) => ({ data, response: new Response(null, { status: 200 }) });

function refused(code: string, extra: Record<string, unknown> = {}) {
  const response = problem(422, code, extra);
  return async () => ({ error: (await response.clone().json()) as unknown, response });
}

/** A call that waits until the test lets it answer. */
function held<T>(data: T) {
  let answer: () => void = () => undefined;
  const call = () =>
    new Promise<ReturnType<typeof ok<T>>>((resolve) => {
      answer = () => {
        resolve(ok(data));
      };
    });
  return {
    call,
    answer: () => {
      answer();
    },
  };
}

describe('[NFR-FE-04] useApiForm', () => {
  it('[NFR-FE-04] is pending while a call runs, and returns its data', async () => {
    const { result } = renderHook(() => useApiForm());
    const pending = held({ id: 1 });
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.send(pending.call);
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      pending.answer();
      expect(await sent).toEqual({ ok: true, data: { id: 1 } });
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.failure).toBeUndefined();
  });

  it('[NFR-FE-04] a second send while one runs sends nothing (a double click)', async () => {
    const { result } = renderHook(() => useApiForm());
    const first = held('first');
    let calls = 0;
    const second = () => {
      calls += 1;
      return Promise.resolve(ok('second'));
    };
    let firstSent: Promise<unknown> = Promise.resolve();
    let secondSent: Promise<unknown> = Promise.resolve();
    act(() => {
      firstSent = result.current.send(first.call);
      secondSent = result.current.send(second);
    });
    await act(async () => {
      first.answer();
      await firstSent;
    });
    expect(await secondSent).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('[NFR-FE-04] keeps a failure, names its field errors, and clears it on the next send', async () => {
    const { result } = renderHook(() => useApiForm());
    await act(async () => {
      await result.current.send(
        refused('VALIDATION_FAILED', {
          details: [{ path: 'body.name', code: 'REQUIRED' }],
        }),
      );
    });
    expect(result.current.failure?.problem.code).toBe('VALIDATION_FAILED');
    expect(result.current.fieldError('body.name')).toBeDefined();
    expect(result.current.fieldError('body.email')).toBeUndefined();

    const next = held('done');
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.send(next.call);
    });
    expect(result.current.failure).toBeUndefined();
    await act(async () => {
      next.answer();
      await sent;
    });
  });

  it('[NFR-FE-04] keepFailure leaves the failure on show while the call runs', async () => {
    const { result } = renderHook(() => useApiForm());
    await act(async () => {
      await result.current.send(refused('ACCOUNT_NOT_VERIFIED'));
    });
    const follow = held('sent');
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.send(follow.call, { keepFailure: true });
    });
    expect(result.current.failure?.problem.code).toBe('ACCOUNT_NOT_VERIFIED');
    await act(async () => {
      follow.answer();
      await sent;
    });
    act(() => {
      result.current.clearFailure();
    });
    expect(result.current.failure).toBeUndefined();
  });

  it('[NFR-FE-04] a call that throws is a failure, not a rejection', async () => {
    const { result } = renderHook(() => useApiForm());
    await act(async () => {
      const outcome = await result.current.send(() => Promise.reject(new Error('broken')));
      expect(outcome?.ok).toBe(false);
    });
    expect(result.current.failure?.problem.code).toBe('INTERNAL_ERROR');
    expect(result.current.pending).toBe(false);
  });
});

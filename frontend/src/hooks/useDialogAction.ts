import type { ErrorCode } from '@po/contracts';
import { useState } from 'react';
import { submit, type ApiFailure } from '../api/submit';

type ApiCall<T> = () => Promise<{ data?: T; error?: unknown; response: Response }>;

export interface DialogActionOptions {
  /** Rereads what the page shows: after a success, and after a failure `isStale` names. */
  refresh?: () => Promise<unknown>;
  /** Failures meaning the page behind the dialog is out of date. */
  isStale?: (code: string) => boolean;
}

/**
 * One action from a ConfirmDialog: on success `refresh` and then `done` run; on failure it
 * stays in `error`, for the dialog to show through its `error` prop. `run` resolves to
 * whether the call succeeded.
 */
export function useDialogAction({ refresh, isStale }: DialogActionOptions = {}) {
  const [error, setError] = useState<ApiFailure>();
  async function run<T>(call: ApiCall<T>, done?: (data: T) => void): Promise<boolean> {
    setError(undefined);
    const outcome = await submit(call);
    if (!outcome.ok) {
      setError(outcome);
      if (isStale?.(outcome.problem.code)) await refresh?.();
      return false;
    }
    await refresh?.();
    done?.(outcome.data);
    return true;
  }
  const clearError = () => {
    setError(undefined);
  };
  return { error, clearError, run };
}

/**
 * A dialog's Reload, offered when the failure means its data is out of date: it rereads
 * the data, then closes the dialog when `onClose` is given.
 */
export function reloadAction(
  error: ApiFailure | undefined,
  isStale: (code: string) => boolean,
  onReload: () => void,
  { label = 'Reload', onClose }: { label?: string; onClose?: () => void } = {},
): readonly { label: string; onPress: () => void }[] {
  return error && isStale(error.problem.code)
    ? [
        {
          label,
          onPress: () => {
            onReload();
            onClose?.();
          },
        },
      ]
    : [];
}

/** Only a version conflict: the dialog's data changed under the user. */
export const isVersionConflict = (code: string): boolean =>
  code === ('VERSION_CONFLICT' satisfies ErrorCode);

/**
 * Failures meaning the order behind a dialog has changed: its version moved, another action
 * moved its state first (an approve, reject or withdraw), or it is no longer readable (a
 * withdrawn order, for an Approver).
 */
const ORDER_STALE_CODES = [
  'VERSION_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'NOT_FOUND',
  // A receipt completed the order behind the cancel dialog (slice 6).
  'ORDER_FULLY_RECEIVED',
] as const satisfies readonly ErrorCode[];

export const isOrderStale = (code: string): boolean =>
  (ORDER_STALE_CODES as readonly string[]).includes(code);

/** An order dialog's "Reload order": rereads the order and closes the dialog. */
export function reloadOrderAction(
  error: ApiFailure | undefined,
  onReload: () => void,
  onClose: () => void,
): readonly { label: string; onPress: () => void }[] {
  return reloadAction(error, isOrderStale, onReload, { label: 'Reload order', onClose });
}

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

/** A dialog's Reload, offered when the failure means its data is out of date. */
export function reloadAction(
  error: ApiFailure | undefined,
  isStale: (code: string) => boolean,
  onReload: () => void,
): readonly { label: string; onPress: () => void }[] {
  return error && isStale(error.problem.code) ? [{ label: 'Reload', onPress: onReload }] : [];
}

/** Only a version conflict: the dialog's data changed under the user. */
export const isVersionConflict = (code: string): boolean =>
  code === ('VERSION_CONFLICT' satisfies ErrorCode);

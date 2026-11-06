import type { ErrorCode } from '@po/contracts';
import { useState } from 'react';
import { submit } from '../../api/submit';
import type { ProblemLike } from '../../errors/messages';
import { useRefreshAdmin } from './queries';

/** Failures meaning someone else got there first. A version conflict has its own Reload. */
const STALE_CODES: ReadonlySet<string> = new Set([
  'ACCESS_REQUEST_NOT_OPEN',
  'NOT_FOUND',
] satisfies ErrorCode[]);

/**
 * One admin action from a dialog: on success every admin read refreshes and `done` runs;
 * on failure the problem stays in `error`, for the dialog to show inside it.
 */
export function useDialogAction() {
  const refresh = useRefreshAdmin();
  const [error, setError] = useState<ProblemLike>();
  async function run(
    call: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
    done: () => void,
  ) {
    setError(undefined);
    const outcome = await submit(call);
    if (!outcome.ok) {
      setError(outcome.problem);
      // Changed or gone under the admin: the lists behind the dialog are out of date.
      if (STALE_CODES.has(outcome.problem.code)) await refresh();
      return;
    }
    await refresh();
    done();
  }
  const clearError = () => {
    setError(undefined);
  };
  return { error, clearError, run };
}

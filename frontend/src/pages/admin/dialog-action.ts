import { useState } from 'react';
import { submit } from '../../api/submit';
import type { ProblemLike } from '../../errors/messages';
import { useRefreshAdmin } from './queries';

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

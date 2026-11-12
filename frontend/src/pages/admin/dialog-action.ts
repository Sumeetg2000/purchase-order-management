import type { ErrorCode } from '@po/contracts';
import { useDialogAction } from '../../hooks/useDialogAction';
import { useRefreshAdmin } from './queries';

/** Failures meaning someone else got there first. A version conflict has its own Reload. */
const STALE_CODES: ReadonlySet<string> = new Set([
  'ACCESS_REQUEST_NOT_OPEN',
  'NOT_FOUND',
] satisfies ErrorCode[]);

/**
 * One admin action from a dialog (useDialogAction): every admin read refreshes after a
 * success, and after a failure that means the lists behind the dialog are out of date.
 */
export function useAdminDialogAction() {
  return useDialogAction({
    refresh: useRefreshAdmin(),
    isStale: (code) => STALE_CODES.has(code),
  });
}

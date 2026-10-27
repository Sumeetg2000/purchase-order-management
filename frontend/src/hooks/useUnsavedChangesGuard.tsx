import { useEffect, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { ConfirmDialog } from '../components/ConfirmDialog';

/**
 * Guards unsaved changes (contracts/ui-components.md, ADR-0018). While isDirty, in-app
 * navigation to another page opens a "Discard your unsaved changes?" dialog, and a reload
 * or tab close gets the browser's own prompt. Render the returned element (the dialog
 * while a navigation is held). Needs a data router, for useBlocker.
 */
export function useUnsavedChangesGuard(isDirty: boolean): ReactNode {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );

  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [isDirty]);

  if (blocker.state !== 'blocked') return null;
  return (
    <ConfirmDialog
      title="Discard your unsaved changes?"
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      tone="danger"
      onConfirm={() => {
        blocker.proceed();
        return Promise.resolve();
      }}
      onClose={() => {
        blocker.reset();
      }}
    >
      Your changes on this page haven&apos;t been saved. If you leave now, they&apos;ll be lost.
    </ConfirmDialog>
  );
}

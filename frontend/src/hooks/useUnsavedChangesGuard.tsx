import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { ConfirmDialog } from '../components/ConfirmDialog';

export interface UnsavedChangesGuard {
  /** Render it: the dialog while a navigation is held. */
  dialog: ReactNode;
  /**
   * Call before navigating away right after a save, in the same handler: the guard sees a
   * cleared dirty flag only after React re-renders, so without this it would still ask.
   */
  release: () => void;
}

/**
 * Guards unsaved changes (contracts/ui-components.md, ADR-0018). While isDirty, in-app
 * navigation to another page opens a "Discard your unsaved changes?" dialog, and a reload
 * or tab close gets the browser's own prompt. If the changes are saved while the dialog is
 * open, it closes and the page stays. Needs a data router, for useBlocker.
 */
export function useUnsavedChangesGuard(isDirty: boolean): UnsavedChangesGuard {
  // Read at navigation time, so release() takes effect before the next render.
  const guarding = useRef(isDirty);
  useEffect(() => {
    guarding.current = isDirty;
  }, [isDirty]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      guarding.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );

  useEffect(() => {
    if (!isDirty && blocker.state === 'blocked') blocker.reset();
  }, [isDirty, blocker]);

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

  const release = useCallback(() => {
    guarding.current = false;
  }, []);

  const dialog =
    blocker.state === 'blocked' ? (
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
    ) : null;

  return { dialog, release };
}

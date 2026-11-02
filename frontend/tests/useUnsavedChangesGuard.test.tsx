import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { createMemoryRouter, Link, RouterProvider, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useUnsavedChangesGuard } from '../src/hooks/useUnsavedChangesGuard';
import { axeViolations } from './support/axe';

function EditPage() {
  const [dirty, setDirty] = useState(false);
  const { dialog, release } = useUnsavedChangesGuard(dirty);
  const navigate = useNavigate();
  // A save finishing in the background, fired by the test when it chooses.
  useEffect(() => {
    const saved = () => {
      setDirty(false);
    };
    window.addEventListener('test:saved', saved);
    return () => {
      window.removeEventListener('test:saved', saved);
    };
  }, []);
  return (
    <>
      <h1>Edit vendor</h1>
      <button
        type="button"
        onClick={() => {
          setDirty(true);
        }}
      >
        Change name
      </button>
      <button
        type="button"
        onClick={() => {
          setDirty(false);
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          // A save that leaves in the same handler, before React re-renders.
          setDirty(false);
          release();
          void navigate('/elsewhere');
        }}
      >
        Save and close
      </button>
      <Link to="/elsewhere">Elsewhere</Link>
      {dialog}
    </>
  );
}

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <EditPage /> },
      { path: '/elsewhere', element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  return { user: userEvent.setup(), router };
}

function beforeUnloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('[NFR-FE-09] unsaved-changes guard', () => {
  it('[NFR-FE-09] does nothing while there are no unsaved changes', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[NFR-FE-09] navigating away while dirty asks first; keeping stays, discarding leaves', async () => {
    const { user, router } = setup();
    await user.click(screen.getByRole('button', { name: 'Change name' }));
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard your unsaved changes?');
    expect(await axeViolations(dialog)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(router.state.location.pathname).toBe('/');

    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
  });

  it('[NFR-FE-09] after a save the guard is released', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Change name' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
  });

  it('[NFR-FE-09] a save that leaves in the same handler is not asked about', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Change name' }));
    await user.click(screen.getByRole('button', { name: 'Save and close' }));
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[NFR-FE-09] the dialog closes, staying on the page, if the changes are saved while it is open', async () => {
    const { user, router } = setup();
    await user.click(screen.getByRole('button', { name: 'Change name' }));
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('test:saved'));
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(router.state.location.pathname).toBe('/');
  });

  it('[NFR-FE-09] a reload or tab close is guarded by beforeunload only while dirty', async () => {
    const { user } = setup();
    expect(beforeUnloadPrevented()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Change name' }));
    expect(beforeUnloadPrevented()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(beforeUnloadPrevented()).toBe(false);
  });
});

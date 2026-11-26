import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { clearEndedSession } from '../../src/auth/session-events';
import { preloadPages } from './preload-pages';

// Testing Library's automatic cleanup needs test globals, which this suite doesn't enable.
// The reason a session ended is kept per tab (session-events.ts); each test is a new tab.
afterEach(() => {
  cleanup();
  clearEndedSession();
});

// Before any test: every lazy page loaded, so no test waits on a page's first import.
await preloadPages();

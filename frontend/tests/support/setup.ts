import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library's automatic cleanup needs test globals, which this suite doesn't enable.
afterEach(() => {
  cleanup();
});

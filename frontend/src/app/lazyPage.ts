import type { ComponentType } from 'react';

/**
 * A page's code couldn't be loaded. Usually an open tab after a deploy: it asks for a hashed
 * chunk the new build doesn't have. Reloading fetches the current index.html (never cached)
 * and its chunks.
 */
export class ChunkLoadError extends Error {
  override readonly name = 'ChunkLoadError';

  constructor(options?: { cause?: unknown }) {
    super('A page of the app could not be loaded', options);
  }
}

/** A route's lazy() for a page component, reporting a failed load as a ChunkLoadError. */
export function lazyPage(load: () => Promise<ComponentType>) {
  return async () => {
    try {
      return { Component: await load() };
    } catch (cause) {
      throw new ChunkLoadError({ cause });
    }
  };
}

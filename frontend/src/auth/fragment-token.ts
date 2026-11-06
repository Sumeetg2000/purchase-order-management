import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';

/** The token in a link's fragment (#token=…): browsers never send it to a server. */
function tokenFrom(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? undefined;
}

/**
 * The one-time token of the link that opened the page (ADR-0017). Read once, then removed
 * from the address bar, so it stays out of history and any shared screenshot.
 */
export function useFragmentToken(): string | undefined {
  const location = useLocation();
  const [token] = useState(() => tokenFrom(location.hash));
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);
  return token;
}

/** One cookie's value from a Cookie string (document.cookie), decoded. */
export function readCookie(cookies: string, name: string): string | undefined {
  for (const pair of cookies.split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(separator + 1).trim());
      } catch {
        // A malformed value is no token: send none, and the API refuses the call.
        return undefined;
      }
    }
  }
  return undefined;
}

/** The browser's cookies; empty where there is no document (tests in Node). */
export function documentCookies(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

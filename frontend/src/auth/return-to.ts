// Where to go after login. Only a path inside the app is followed: anything else (another
// origin, //host, a backslash trick) falls back to the home page.

const HOME = '/';

export function safeReturnTo(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return HOME;
  if (value === '/login' || value.startsWith('/login?')) return HOME;
  return value;
}

export function loginPath(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

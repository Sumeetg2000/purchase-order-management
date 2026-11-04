// A session's device, as the sessions list names it: the browser and the system from its
// user agent ("Chrome on Linux"), or the user agent itself when neither is recognised.

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iOS/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const first = (agent: string, table: readonly [RegExp, string][]) =>
  table.find(([pattern]) => pattern.test(agent))?.[1];

export function describeDevice(userAgent: string): string {
  const browser = first(userAgent, BROWSERS);
  const system = first(userAgent, SYSTEMS);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? (userAgent || 'Unknown device');
}

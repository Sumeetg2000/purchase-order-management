// The one membership check for a const list of literals (a role, a code, an access level):
// narrows `value` to the list's union without a cast at each call site.

/** Whether `value` is one of `list`'s members, narrowing it to their union. */
export function oneOf<const T>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

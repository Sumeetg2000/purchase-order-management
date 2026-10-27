/**
 * The named classes of a CSS module, typed as strings. A name the stylesheet doesn't
 * define throws when the module loads, so a typo fails the first test that renders it
 * instead of silently dropping a style.
 */
export function classes<const K extends string>(
  module: CSSModuleClasses,
  ...names: K[]
): Readonly<Record<K, string>> {
  const found = {} as Record<K, string>;
  for (const name of names) {
    const value = module[name];
    if (value === undefined) throw new Error(`CSS module has no class "${name}"`);
    found[name] = value;
  }
  return found;
}

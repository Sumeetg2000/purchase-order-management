/**
 * The named classes of a CSS module, typed as strings. A name the stylesheet doesn't
 * define throws when the module loads. The component tests process CSS modules for real
 * (vitest.config.ts), so a typo fails there instead of in the production build.
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

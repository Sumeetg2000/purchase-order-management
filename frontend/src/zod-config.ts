// Zod builds object schemas with a JIT parser when it may use `new Function`, and probes
// for that once. Under the CSP's script-src 'self' the probe is blocked and, although Zod
// catches the error, the browser reports a violation. jitless skips it.
//
// Zod reads `jitless` as each object schema is built, from globalThis.__zod_globalConfig.
// So this sets that global without importing Zod, and runs first: index.html loads it as
// its own module script ahead of the app, because a shared chunk that builds schemas (Zod
// with @po/contracts) would otherwise evaluate before any code in the app's entry.
// Mutating the object, not replacing it, keeps it right whichever loads first.

const target = globalThis as { __zod_globalConfig?: Record<string, unknown> };
(target.__zod_globalConfig ??= {})['jitless'] = true;

export {};

// Zod builds object schemas with a JIT parser when it may use `new Function`, and probes
// for that once. Under the CSP's script-src 'self' the probe is blocked and, although Zod
// catches the error, the browser reports a violation. jitless skips it.
//
// Zod reads `jitless` from globalThis.__zod_globalConfig as each object schema is built,
// and schemas are built as soon as their bundle chunk runs. So this is a classic script in
// index.html's head, outside the bundle: it runs before any module script, whatever the
// chunk layout. Mutating the object, not replacing it, keeps it right whichever runs first.
(globalThis.__zod_globalConfig ??= {}).jitless = true;

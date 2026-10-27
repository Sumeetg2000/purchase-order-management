import { config } from 'zod';

// Zod builds object schemas with a JIT parser when it may use `new Function`, and probes
// for that by calling it once. Under the CSP's script-src 'self' the probe is blocked and,
// although Zod catches the error, the browser reports a violation. jitless skips the
// probe. It must run before any schema is built, so main.tsx imports this module first.
config({ jitless: true });

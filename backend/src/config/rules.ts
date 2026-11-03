import { z } from 'zod';

// Shared building blocks for the per-process config schemas (contracts/config.md).

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export const appEnv = z.enum(['local', 'test', 'production']);
export const logLevel = z.enum(LOG_LEVELS).default('info');
export const port = z.coerce.number().int().min(1).max(65_535);
export const positiveInt = z.coerce.number().int().positive();
export const secret = z.string().min(16, 'must be at least 16 characters');

/** The shortest signing or HMAC secret accepted, in bytes (256 bits, for HS256). */
export const SIGNING_SECRET_MIN_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * A base64url-encoded secret of at least SIGNING_SECRET_MIN_BYTES bytes. Messages never
 * echo the value.
 */
export const signingSecret = z.string().superRefine((value, ctx) => {
  // A length of 1 mod 4 can't be valid base64url: it would end mid-byte.
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    ctx.addIssue({ code: 'custom', message: 'must be base64url (A-Z, a-z, 0-9, - and _)' });
  } else if (Buffer.from(value, 'base64url').length < SIGNING_SECRET_MIN_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `must decode to at least ${String(SIGNING_SECRET_MIN_BYTES)} bytes`,
    });
  }
});

/** The longest key id accepted in a JWT header (`kid`). */
export const KEY_ID_MAX_LENGTH = 64;

export const keyId = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9._-]{1,${String(KEY_ID_MAX_LENGTH)}}$`),
    `must be 1-${String(KEY_ID_MAX_LENGTH)} letters, digits, dots, hyphens or underscores`,
  );

// A DNS name of two or more labels: letters, digits and inner hyphens, a letter TLD.
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A comma-separated list of domains, trimmed and lower-cased: at least one, no empty
 * entries, no duplicates.
 */
export const domainList = z.string().transform((value, ctx) => {
  const domains = value.split(',').map((entry) => entry.trim().toLowerCase());
  for (const domain of domains) {
    if (!DOMAIN.test(domain)) {
      ctx.addIssue({
        code: 'custom',
        message: domain
          ? `"${domain}" is not a domain such as example.com`
          : 'must be a comma-separated list of domains with no empty entries',
      });
    }
  }
  const repeated = domains.find((domain, index) => domain && domains.indexOf(domain) !== index);
  if (repeated) {
    ctx.addIssue({ code: 'custom', message: `lists "${repeated}" more than once` });
  }
  return domains;
});

/** `true` or `false` only; `z.coerce.boolean()` would read "false" as true. */
export const envBoolean = z
  .enum(['true', 'false'], { error: 'must be true or false' })
  .transform((v) => v === 'true');

/** Unset and empty both mean "not configured". */
export function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** An origin such as `http://localhost:8080`: scheme, host and port, nothing else. */
export const origin = z.string().refine(
  (value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  },
  {
    error:
      'must be an absolute origin such as https://po.example.com, with no path or trailing slash',
  },
);

/** A PostgreSQL connection URL that must log in as one specific role. */
export function databaseUrl(role: 'po_app' | 'po_owner' | 'po_maintenance') {
  return z.string().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a postgres:// connection URL' });
      return;
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      ctx.addIssue({ code: 'custom', message: 'must be a postgres:// connection URL' });
    } else if (decodeURIComponent(url.username) !== role) {
      ctx.addIssue({ code: 'custom', message: `must connect as ${role} (credential separation)` });
    }
  });
}

export interface ProcessConfig<T = Record<string, unknown>> {
  process: string;
  /** Every variable the process reads; all are documented in `.env.example`. */
  keys: readonly string[];
  schema: z.ZodType<T>;
}

const PLACEHOLDER = 'change-me-';

function placeholderIn(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith(PLACEHOLDER)) return true;
  try {
    // Composed database URLs embed a password.
    return decodeURIComponent(new URL(value).password).startsWith(PLACEHOLDER);
  } catch {
    return false;
  }
}

/**
 * Builds a process schema:
 * - `forbidden` names variables whose mere presence refuses startup (credential
 *   separation). It is checked even when other keys are invalid.
 * - With `APP_ENV=production`, any read value that is or embeds a `change-me-`
 *   placeholder is refused.
 * - `refine` adds process-specific rules on the parsed values.
 * The parsed result holds only the process's own keys.
 */
export function defineProcessConfig<
  Shape extends z.ZodRawShape & { APP_ENV: typeof appEnv },
>(options: {
  process: string;
  shape: Shape;
  forbidden?: (key: string) => boolean;
  refine?: (config: z.output<z.ZodObject<Shape>>, ctx: z.RefinementCtx) => void;
}): ProcessConfig<z.output<z.ZodObject<Shape>>> {
  const { process, shape, forbidden, refine } = options;
  const keys = Object.keys(shape);

  const schema = z
    .looseObject(shape)
    .superRefine(
      (env, ctx) => {
        if (!forbidden) return;
        for (const [key, value] of Object.entries(env)) {
          if (value !== undefined && forbidden(key)) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: `must not be set for the ${process} process (credential separation)`,
            });
          }
        }
      },
      { when: () => true },
    )
    .superRefine((env, ctx) => {
      if (env['APP_ENV'] !== 'production') return;
      for (const key of keys) {
        if (placeholderIn(env[key])) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `is a ${PLACEHOLDER} placeholder, which production refuses`,
          });
        }
      }
    })
    .superRefine((env, ctx) => refine?.(env as z.output<z.ZodObject<Shape>>, ctx))
    .transform((env) => {
      const picked: Record<string, unknown> = {};
      for (const key of keys) {
        if (env[key] !== undefined) picked[key] = env[key];
      }
      return picked as z.output<z.ZodObject<Shape>>;
    });

  return { process, keys, schema };
}

/** Owner, superuser and per-role passwords: only migrate may hold them. */
export function isPrivilegedDatabaseKey(key: string): boolean {
  return (
    key === 'OWNER_DATABASE_URL' || key === 'POSTGRES_PASSWORD' || /^DB_.+_PASSWORD$/.test(key)
  );
}

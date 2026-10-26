import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

// Structured JSON logs to stdout (ADR-0020), redacted before they are written (research
// R10). The only path that may print a one-time link is logOneTimeLink.

export const REDACTED = '[Redacted]';

/** Keys whose values are never logged, at any depth: credentials, tokens, phone numbers. */
const SENSITIVE_KEY = /password|passwd|token|secret|phone|cookie|authorization/i;
// Keys that are or end in "key", as the config loader treats *_KEY: key, api_key,
// x-api-key, SIGNING_KEY, apiKey, privateKey. Not words like "monkey" or "keyboard".
const KEY_SUFFIX = /(?:^|[_.-])key$/i;
const CAMEL_KEY_SUFFIX = /[a-z0-9]Key$/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || KEY_SUFFIX.test(key) || CAMEL_KEY_SUFFIX.test(key);
}

// scheme://user:password@host: the password part, up to the @.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;

/** Masks the password of every credentialed URL in a string, keeping the user and host. */
export function maskUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const MAX_DEPTH = 10;

/**
 * Copies plain objects and arrays, replacing sensitive values; leaves other objects alone.
 * Anything nested deeper than MAX_DEPTH is replaced too, so nothing escapes unchecked.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(inner, depth + 1);
  }
  return out;
}

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/**
 * Redacts the values of sensitive query parameters and leaves every other byte of the URL
 * as the client sent it. Keys are decoded before matching, so encoding can't hide them.
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const pairs = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      const key = equals === -1 ? pair : pair.slice(0, equals);
      return isSensitiveKey(decodedKey(key)) ? `${key}=${REDACTED}` : pair;
    });
  return `${url.slice(0, queryStart)}?${pairs.join('&')}`;
}

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
}

interface SerializedResponse {
  statusCode?: number;
  headers?: Record<string, unknown>;
}

/** pino-http request serializer: method, redacted URL and headers; no raw query. */
export function serializeRequest(req: SerializedRequest) {
  return {
    method: req.method,
    url: req.url === undefined ? undefined : redactUrl(req.url),
    headers: redactDeep(req.headers ?? {}),
    remoteAddress: req.remoteAddress,
  };
}

export function serializeResponse(res: SerializedResponse) {
  return { statusCode: res.statusCode, headers: redactDeep(res.headers ?? {}) };
}

/**
 * pino's error serializer, redacted. pino runs the log formatter before serializers, so an
 * Error's own properties (headers, driver metadata, its cause chain) would otherwise reach
 * the output untouched. The serialized error becomes plain data first so it can be walked.
 */
export function serializeError(error: unknown): unknown {
  const serialized: unknown = pino.stdSerializers.err(error as Error);
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(serialized));
  } catch {
    plain = { type: (serialized as { type?: unknown } | null)?.type };
  }
  return redactDeep(plain);
}

export function createLogger(
  level: LevelWithSilent = 'info',
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    // The message string is not part of the object the formatter sees, so mask it here.
    hooks: {
      logMethod(this: Logger, args: Parameters<Logger['info']>, method: Logger['info']) {
        const masked = args.map((arg: unknown) =>
          typeof arg === 'string' ? maskUrlCredentials(arg) : arg,
        ) as Parameters<Logger['info']>;
        method.apply(this, masked);
      },
    },
    formatters: {
      log: (object: Record<string, unknown>) => redactDeep(object) as Record<string, unknown>,
    },
    serializers: { err: serializeError, req: serializeRequest, res: serializeResponse },
  };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * The one sanctioned way to log a one-time set-password link (the bootstrap and the
 * create-admin command). The marker lets the log checks allow exactly these lines.
 */
export function logOneTimeLink(logger: Logger, link: string, message: string): void {
  logger.info({ oneTimeLink: true, link }, message);
}

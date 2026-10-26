import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

// Structured JSON logs to stdout (ADR-0020), redacted before they are written (research
// R10). The only path that may print a one-time link is logOneTimeLink.

export const REDACTED = '[Redacted]';

/** Keys whose values are never logged, at any depth: credentials, tokens, phone numbers. */
const SENSITIVE_KEY = /password|passwd|token|secret|phone|cookie|authorization/i;

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
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactDeep(inner, depth + 1);
  }
  return out;
}

/** Redacts the values of sensitive query parameters, keeping the rest of the URL. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_KEY.test(key)) params.set(key, REDACTED);
  }
  return `${url.slice(0, queryStart)}?${params.toString().replaceAll('%5BRedacted%5D', REDACTED)}`;
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

export function createLogger(
  level: LevelWithSilent = 'info',
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    formatters: {
      log: (object: Record<string, unknown>) => redactDeep(object) as Record<string, unknown>,
    },
    serializers: { err: pino.stdSerializers.err, req: serializeRequest, res: serializeResponse },
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

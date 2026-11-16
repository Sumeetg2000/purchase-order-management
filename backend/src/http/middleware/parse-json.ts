import { AppError, BODY_LIMIT_BYTES } from '@po/contracts';
import type { Request, RequestHandler } from 'express';

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

const unsupportedMediaType = () =>
  new AppError('VALIDATION_FAILED', {
    details: [{ path: 'header.content-type', code: 'UNSUPPORTED_MEDIA_TYPE' }],
  });

const malformedJson = () =>
  new AppError('VALIDATION_FAILED', { details: [{ path: 'body', code: 'MALFORMED_JSON' }] });

/** UTF-8 only (RFC 8259); a JSON media type may name it, or no charset at all. */
function charsetSupported(req: Request): boolean {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(req.headers['content-type'] ?? '');
  return match === null || match[1]?.toLowerCase() === 'utf-8';
}

/**
 * Reads at most `limit` bytes. Past the limit it stops: no more is read, and the error
 * handler closes the connection, so a streamed (chunked) body is never read to its end
 * (slice 3 research R8). body-parser instead reads an over-limit body to its end before
 * answering, so it isn't used.
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const stop = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.pause();
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        stop();
        reject(new AppError('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      stop();
      resolve(Buffer.concat(chunks, received));
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    const onAborted = () => {
      stop();
      reject(malformedJson());
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** Strict JSON (an object or an array), as body-parser's strict mode; empty is `{}`. */
function parseStrict(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw malformedJson();
  }
  if (text.trim() === '') return {};
  if (!/^[\s]*[[{]/.test(text)) throw malformedJson();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw malformedJson();
  }
}

/**
 * Body handling for every request that carries one, after the caller may use the route,
 * up to the operation's limit (1 MiB unless it declares more), in this order (ADR-0007):
 * 1. over the limit by Content-Length → 413, before reading
 * 2. not application/json in UTF-8, or a compressed body → 400 UNSUPPORTED_MEDIA_TYPE
 * 3. read, stopping past the limit (413), then parse; malformed JSON → 400 MALFORMED_JSON
 * A refusal leaves the rest of the body unread: the error handler closes the connection.
 */
export function parseJson(limit: number = BODY_LIMIT_BYTES): RequestHandler {
  return (req, _res, next) => {
    if (!hasBody(req)) {
      next();
      return;
    }
    if (Number(req.headers['content-length']) > limit) {
      next(new AppError('PAYLOAD_TOO_LARGE'));
      return;
    }
    const encoding = req.headers['content-encoding']?.toLowerCase() ?? 'identity';
    if (req.is('application/json') === false || !charsetSupported(req) || encoding !== 'identity') {
      next(unsupportedMediaType());
      return;
    }
    readBody(req, limit).then(
      (bytes) => {
        try {
          req.body = parseStrict(bytes);
        } catch (error) {
          next(error);
          return;
        }
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}

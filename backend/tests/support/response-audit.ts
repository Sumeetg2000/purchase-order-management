import { Server } from 'node:http';
import { ERROR_CODES } from '@po/contracts';
import request from 'supertest';
import { afterAll, expect } from 'vitest';
import { capturedLines } from './log-capture.js';
import { isDocumentedPath, validateResponse } from './openapi-validator.js';

// Every error response the suite sees from an API app (SC-002) must be problem+json with a
// registered code and a correlationId equal to its X-Request-Id header and present in the
// log lines. Every error response, and every response from a documented path, must also
// match the committed OpenAPI document (FR-022); success responses from test-only routes
// have no documentation to match. Supertest is hooked once per test file; the metrics
// listener (a plain http.Server, not an Express app) is not the API and is skipped.

interface SeenResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type EndCallback = (err: unknown, res?: SeenResponse) => void;
interface TestPrototype {
  end: (this: { app?: unknown }, fn?: EndCallback) => unknown;
}

const seen: { method: string; url: string; res: SeenResponse }[] = [];
const proto = (request as unknown as { Test: { prototype: TestPrototype } }).Test.prototype;
const originalEnd = proto.end;

/**
 * Whether a request targets an API app. supertest wraps an app function in
 * http.createServer before building the request, so look through the server to its
 * request listener: the API is an Express app; the metrics listener is a plain handler.
 */
function isApiApp(target: unknown): boolean {
  const app = target instanceof Server ? target.listeners('request')[0] : target;
  return typeof app === 'function' && typeof (app as { handle?: unknown }).handle === 'function';
}

proto.end = function (this: { app?: unknown; method?: string; url?: string }, fn?: EndCallback) {
  const recorded = isApiApp(this.app);
  return originalEnd.call(this, (err, res) => {
    if (recorded && res) seen.push({ method: this.method ?? '', url: this.url ?? '', res });
    fn?.(err, res);
  });
};

function problems(entry: (typeof seen)[number]): string[] {
  const { res } = entry;
  const found: string[] = [];
  const body = (res.body ?? {}) as Record<string, unknown>;
  const header = res.headers['x-request-id'];
  if (!/^application\/problem\+json/.test(res.headers['content-type'] ?? '')) {
    found.push(`content-type ${String(res.headers['content-type'])}`);
  }
  if (!(ERROR_CODES as readonly unknown[]).includes(body['code'])) {
    found.push(`unregistered code ${String(body['code'])}`);
  }
  if (typeof header !== 'string' || body['correlationId'] !== header) {
    found.push(`correlationId ${String(body['correlationId'])} != X-Request-Id ${String(header)}`);
  } else if (!capturedLines().some((line) => line['requestId'] === header)) {
    found.push(`no log line carries request id ${header}`);
  }
  return found.map((p) => `${entry.method} ${entry.url} ${String(res.status)}: ${p}`);
}

/** What the audit has recorded in this test file so far (for the audit's own test). */
export function auditedResponses(): { method: string; path: string; status: number }[] {
  return seen.map((entry) => ({
    method: entry.method,
    path: new URL(entry.url).pathname,
    status: entry.res.status,
  }));
}

function contractProblems(entry: (typeof seen)[number]): string[] {
  const path = new URL(entry.url).pathname;
  if (entry.res.status < 400 && !isDocumentedPath(path)) return [];
  return validateResponse({
    method: entry.method,
    path,
    status: entry.res.status,
    headers: entry.res.headers,
    body: entry.res.body,
  });
}

afterAll(() => {
  const failures = seen.filter((entry) => entry.res.status >= 400).flatMap(problems);
  expect(failures, 'error responses outside the standard shape').toEqual([]);
  expect(seen.flatMap(contractProblems), 'responses that break the OpenAPI document').toEqual([]);
});

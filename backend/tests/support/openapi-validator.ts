import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

// Validates an API response against the committed OpenAPI document
// (packages/contracts/openapi/openapi.json, ADR-0008), never against the Zod schemas it was
// generated from, so a stale committed document fails here as well as in the drift check.

type Json = Record<string, unknown>;

const DOCUMENT_ID = 'openapi.json';
const document = JSON.parse(
  readFileSync(
    new URL('../../../packages/contracts/openapi/openapi.json', import.meta.url),
    'utf8',
  ),
) as Json;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(document, DOCUMENT_ID);

function pointer(path: readonly string[]): string {
  return path.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
}

function at(path: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of path) node = (node as Json | undefined)?.[key];
  return node;
}

/** Follows a local `#/...` reference to its target and the target's path. */
function resolve(node: unknown, path: string[]): { node: Json; path: string[] } {
  const ref = (node as Json | undefined)?.['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const target = ref.slice(2).split('/');
    return resolve(at(target), target);
  }
  return { node: node as Json, path };
}

/** The document path whose pattern matches a request path, e.g. /items/{id}. */
function documentedPath(requestPath: string): string | undefined {
  const paths = Object.keys(document['paths'] ?? {});
  return paths.find((candidate) => {
    const pattern = candidate.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+');
    return new RegExp(`^${pattern}$`).test(requestPath);
  });
}

/** Whether the document has a path matching this request path. */
export function isDocumentedPath(requestPath: string): boolean {
  return documentedPath(requestPath) !== undefined;
}

export interface ResponseToValidate {
  method: string;
  /** The request path without the query string, as the API sees it (no /api prefix). */
  path: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Problems with a response, empty when it matches the document. A documented operation
 * must answer with a status it declares (its catch-all default is for clients, not a
 * licence to return anything), and an error body's code must be one the status lists in
 * x-error-codes. Anything else (an unknown path or method) must be an error answered with
 * the shared Problem response.
 */
export function validateResponse(res: ResponseToValidate): string[] {
  const label = `${res.method.toUpperCase()} ${res.path} ${String(res.status)}`;
  const docPath = documentedPath(res.path.split('?')[0] ?? res.path);
  const operation = docPath ? at(['paths', docPath, res.method.toLowerCase()]) : undefined;

  let responsePath: string[];
  if (operation) {
    const responses = (operation as Json)['responses'] as Json;
    const key = String(res.status);
    if (!(key in responses)) return [`${label}: undocumented status`];
    responsePath = ['paths', docPath ?? '', res.method.toLowerCase(), 'responses', key];
  } else if (res.status >= 400) {
    responsePath = ['components', 'responses', 'Problem'];
  } else {
    return [`${label}: undocumented operation`];
  }

  const { node: response, path } = resolve(at(responsePath), responsePath);
  const errors: string[] = [];

  const declaredCodes = response['x-error-codes'];
  const code = (res.body as Json | null | undefined)?.['code'];
  if (Array.isArray(declaredCodes) && !declaredCodes.includes(code)) {
    errors.push(`${label}: code ${String(code)} is not one of ${declaredCodes.join(', ')}`);
  }

  const headers = (response['headers'] ?? {}) as Json;
  for (const [name, declared] of Object.entries(headers)) {
    const { node: header, path: headerPath } = resolve(declared, [...path, 'headers', name]);
    const value = res.headers[name.toLowerCase()];
    if (value === undefined) {
      if (header['required'] === true) errors.push(`${label}: missing header ${name}`);
      continue;
    }
    const validate = ajv.getSchema(`${DOCUMENT_ID}#/${pointer([...headerPath, 'schema'])}`);
    if (validate && !validate(value)) {
      errors.push(`${label}: header ${name} ${ajv.errorsText(validate.errors)}`);
    }
  }

  const content = (response['content'] ?? {}) as Json;
  const contentType = (res.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  if (!(contentType in content)) {
    errors.push(
      `${label}: content type "${contentType}" is not one of ${Object.keys(content).join(', ')}`,
    );
    return errors;
  }
  const validate = ajv.getSchema(
    `${DOCUMENT_ID}#/${pointer([...path, 'content', contentType, 'schema'])}`,
  );
  if (!validate) return [...errors, `${label}: no schema for ${contentType}`];
  if (!validate(res.body)) errors.push(`${label}: body ${ajv.errorsText(validate.errors)}`);
  return errors;
}

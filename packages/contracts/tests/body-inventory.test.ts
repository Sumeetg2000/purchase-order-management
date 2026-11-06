import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPERATIONS, type HttpMethod, type OperationContract } from '../src/index.js';

// Body-schema inventory (ADR-0007): every mutating operation's body fields, and which are
// required. A new field, or one made optional, changes the inventory and fails the test
// until EXPECTED changes in the same commit, so an action with no input of its own
// (approve takes only `version`) can't grow optional fields unnoticed.

type BodyFields = Record<string, 'required' | 'optional'>;
type BodyInventory = Record<string, 'no body' | BodyFields>;

const MUTATING: readonly HttpMethod[] = ['post', 'put', 'patch', 'delete'];

/** The top-level object a body validates, through refinements and transform pipes. */
function bodyObject(schema: z.core.$ZodType): z.core.$ZodObject {
  const def = schema._zod.def;
  if (def.type === 'object') return schema as z.core.$ZodObject;
  if (def.type === 'pipe') return bodyObject((def as z.core.$ZodPipeDef).in);
  throw new Error(`a request body must be an object schema, not ${def.type}`);
}

function inventory(operations: Readonly<Record<string, OperationContract>>): BodyInventory {
  const result: BodyInventory = {};
  for (const operation of Object.values(operations)) {
    if (!MUTATING.includes(operation.method)) continue;
    const body = operation.request?.body;
    result[operation.operationId] = body
      ? Object.fromEntries(
          Object.entries(bodyObject(body)._zod.def.shape).map(([field, schema]) => [
            field,
            schema._zod.optin === 'optional' ? 'optional' : 'required',
          ]),
        )
      : 'no body';
  }
  return result;
}

/** The reviewed inventory (contracts/api.md), growing story by story with the routes. */
const EXPECTED: BodyInventory = {
  login: { email: 'required', password: 'required' },
  refreshSession: 'no body',
  logout: 'no body',
  logoutAll: 'no body',
  resetPassword: { token: 'required', newPassword: 'required' },
  signup: { name: 'required', email: 'required', password: 'required' },
  verifyEmail: { token: 'required', password: 'required' },
  resendVerification: { email: 'required' },
  sendAccessRequest: { message: 'required' },
  updateUser: { roles: 'optional', isActive: 'optional' },
  sendUserPasswordReset: 'no body',
  dismissAccessRequest: { note: 'optional' },
  updateMe: { name: 'required' },
  changePassword: { currentPassword: 'required', newPassword: 'required' },
  revokeSession: 'no body',
  forgotPassword: { email: 'required' },
};

describe('[NFR-VAL-01] body-schema inventory of mutating operations', () => {
  it('[NFR-VAL-01] every mutating operation has exactly the reviewed body fields', () => {
    expect(inventory(OPERATIONS)).toEqual(EXPECTED);
  });

  it('[NFR-VAL-01] the inventory changes when a field is added or made optional', () => {
    const operation = (
      operationId: string,
      method: HttpMethod,
      body?: z.ZodType,
    ): OperationContract => ({
      method,
      path: `/${operationId}`,
      operationId,
      summary: 'test only',
      access: 'public',
      ...(body === undefined ? {} : { request: { body } }),
      responses: { 200: z.strictObject({}) },
    });
    const approve = z.strictObject({ version: z.number().int() });

    expect(
      inventory({
        approve: operation('approve', 'post', approve),
        remove: operation('remove', 'delete'),
        read: operation('read', 'get', approve),
      }),
    ).toEqual({ approve: { version: 'required' }, remove: 'no body' });

    const grown = approve.extend({ note: z.string().optional() });
    expect(inventory({ approve: operation('approve', 'post', grown) })).toEqual({
      approve: { version: 'required', note: 'optional' },
    });

    const loosened = z.strictObject({ version: z.number().int().optional() });
    expect(inventory({ approve: operation('approve', 'post', loosened) })).toEqual({
      approve: { version: 'optional' },
    });

    const piped = approve.refine(() => true).transform((value) => value);
    expect(inventory({ approve: operation('approve', 'patch', piped) })).toEqual({
      approve: { version: 'required' },
    });
  });
});

// Access requests from users with no role (ADR-0016). The access_requests table's CHECK
// constraints (migration 0009_access_requests) hold the same values; a backend test
// compares them.

export const ACCESS_REQUEST_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** Each status by name, e.g. ACCESS_REQUEST_STATUS.OPEN. */
export const ACCESS_REQUEST_STATUS = Object.fromEntries(
  ACCESS_REQUEST_STATUSES.map((status) => [status, status]),
) as { readonly [S in AccessRequestStatus]: S };

/** The longest message a user may send with an access request (ADR-0007). */
export const ACCESS_REQUEST_MESSAGE_MAX_LENGTH = 500;

/** The longest note an admin may add when dismissing a request (ADR-0007). */
export const ACCESS_REQUEST_NOTE_MAX_LENGTH = 500;

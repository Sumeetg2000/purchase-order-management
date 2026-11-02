/**
 * The correlation ids the API accepts from X-Request-Id and echoes back (research R10):
 * room for a UUID, nothing that could smuggle structure into a log line.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,36}$/;

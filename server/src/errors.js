// An error that is safe to show to the caller, with the HTTP status to use.
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = extra.details ?? null;
    this.hint = extra.hint ?? null;
  }
}

const isSqlState = code => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);

// Database errors keep their SQLSTATE and message, exactly as the portals
// received them before: RPC functions report problems to the user with
// `raise exception`, and the pages match on codes such as 42P01 and 23505.
export function toApiError(error, { signedIn = false } = {}) {
  if (error instanceof ApiError) return error;
  if (error && isSqlState(error.code)) {
    const code = error.code;
    let status = 400;
    if (code === '42501') status = signedIn ? 403 : 401;
    else if (code === '42P01' || code === '42883') status = 404;
    else if (code === '23505' || code === '23503') status = 409;
    else if (/^(08|53|57|58|XX)/.test(code)) status = 503;
    return new ApiError(status, code, error.message, { details: error.detail, hint: error.hint });
  }
  // The database could not be reached (ECONNREFUSED, ETIMEDOUT, pool timeout).
  // 503 tells the portals and readers to keep their session or queue and retry.
  if (error && (/^E[A-Z]+$/.test(error.code || '') || /timeout|terminat/i.test(error.message || ''))) {
    return new ApiError(503, 'database_unavailable', 'The service is temporarily unavailable. Please try again shortly.');
  }
  return null;
}

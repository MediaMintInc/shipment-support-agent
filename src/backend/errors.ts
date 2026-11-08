/**
 * Error taxonomy shared by backend adapters and MCP handlers.
 * Codes are stable strings that appear in MCP tool results so the agent (and evals)
 * can reason about failures without parsing prose.
 */
export const BackendErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  BAD_REQUEST: 'BAD_REQUEST',
  NETWORK_ERROR: 'NETWORK_ERROR',
  DESTINATION_NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
} as const;
export type BackendErrorCode = (typeof BackendErrorCode)[keyof typeof BackendErrorCode];

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly attempts: number;

  constructor(
    code: BackendErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; attempts?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'BackendError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.attempts = opts.attempts ?? 1;
  }

  withAttempts(attempts: number): BackendError {
    return new BackendError(this.code, this.message, {
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
      attempts,
      cause: this.cause,
    });
  }
}

/** Human-oriented guidance attached to tool errors so the agent explains failures accurately. */
export const ERROR_GUIDANCE: Record<BackendErrorCode, string> = {
  NOT_FOUND: 'No record exists for this identifier. Tell the user it was not found; do not guess details.',
  TIMEOUT: 'The backend did not respond in time after bounded retries. Tell the user the lookup failed; do not guess details.',
  RATE_LIMITED: 'The backend is rate limiting requests. Tell the user to try again shortly.',
  UPSTREAM_ERROR: 'The backend returned a server error after bounded retries. Tell the user the system is unavailable.',
  MALFORMED_RESPONSE: 'The backend returned data that failed validation. Do not use or guess any of its contents.',
  BAD_REQUEST: 'The backend rejected the request as invalid.',
  NETWORK_ERROR: 'The backend could not be reached.',
  DESTINATION_NOT_ALLOWED: 'Backend destination is not on the allow-list for this environment.',
  CONFLICT: 'The backend rejected the request because it conflicts with an existing record.',
};

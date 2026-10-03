export class CliError extends Error {
  constructor(code, message, exit = 2, status = null, hint = undefined) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.status = status;
    this.hint = hint;
  }
}

export const inputError = () => new CliError('invalid_input', 'Invalid command or argument. Use --help.');
export const configError = () => new CliError('unsafe_config', 'Credential configuration is invalid or unsafe.');
export const responseError = () => new CliError('invalid_response', 'The API returned an invalid or oversized response.', 7);
export const cancelled = () => new CliError('cancelled', 'Request cancelled.', 130);

const MESSAGES = Object.freeze({
  auth_required: 'A valid API key is required. Create one at https://compoundinterest.ing/account.',
  upgrade_required: 'This operation requires paid API depth. Paid keys are not on sale yet.',
  rate_limited: 'The API rate limit was reached.',
  quota_exceeded: 'The daily API quota was reached.',
  bad_request: 'The API rejected the requested filters or limits.',
  not_found: 'The requested record was not found.',
  evidence_not_published: 'Source evidence has not been published for this ticker.',
  retracted: 'The published evidence was withdrawn.',
  gone: 'This entity was removed from the published universe.',
  snapshot_changed: 'The snapshot changed. Explicitly start a new first-page command.',
  apply_in_progress: 'Publication is being applied. Try again explicitly later.',
  dataset_unavailable: 'The published dataset is unavailable.',
  snapshot_stale: 'The published snapshot is stale.',
  internal: 'The API encountered an internal error.',
  forbidden: 'The API denied this operation.',
  upstream_error: 'The API request failed.',
});

export function remoteError(status, rawCode, hint) {
  const code = typeof rawCode === 'string' && Object.hasOwn(MESSAGES, rawCode) ? rawCode : 'upstream_error';
  const exit = status === 401 ? 3 : status === 402 ? 4 : status === 429 ? 5 : 6;
  return new CliError(code, MESSAGES[code], exit, status, hint);
}

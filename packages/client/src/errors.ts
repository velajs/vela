/**
 * The client's error surface — three tiers:
 * - connection-level: surfaced through `onConnectionStatus('offline')`;
 * - subscription-level: `error` frames → `SubscribeOptions.onError`;
 * - mutation-level: `mutate()` rejects with a {@link VelaLiveError}.
 *
 * Follows lunora's zero-dep catalog pattern (one error class, a small code
 * union, structural guards) inlined rather than published separately.
 */
export class VelaLiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VelaLiveError';
  }
}

export const isVelaLiveError = (value: unknown): value is VelaLiveError =>
  value instanceof VelaLiveError ||
  (typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'VelaLiveError' &&
    typeof (value as { code?: unknown }).code === 'string');

export const getErrorCode = (value: unknown): string | undefined =>
  isVelaLiveError(value) ? value.code : undefined;

/** Decode an HTTP error response into a VelaLiveError (vela's `{ error | message }` shapes tolerated). */
export const toMutationError = async (response: Response): Promise<VelaLiveError> => {
  let code = `http_${response.status}`;
  let message = response.statusText || `mutation failed with status ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string } | string;
      message?: string;
    };
    if (typeof body.error === 'object' && body.error !== null) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    } else if (typeof body.error === 'string') {
      message = body.error;
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // non-JSON body — keep the status-derived error
  }
  return new VelaLiveError(code, message, response.status);
};

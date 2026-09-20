import { CORE_CATALOG, STATUS_TO_CODE, type Catalog } from './catalog';
import { isVelaError } from './guard';

export interface WireErrorObject {
  code: string;
  message: string;
  hint?: string;
  docsUrl?: string;
  details?: unknown;
}

export interface ErrorBodyResult {
  body: { error: WireErrorObject };
  status: number;
  redacted: boolean;
}

export interface ToErrorBodyOptions {
  /** Composed catalog; defaults to the core catalog. */
  catalog?: Catalog<string>;
  /** Status used for unbranded errors. Default 500. */
  fallbackStatus?: number;
  redactedMessage?: (status: number) => string;
  /** Injectable wire codec for `data` → `details` (bigint/bytes etc.). */
  encodeData?: (data: unknown) => unknown;
  /** Default true. */
  includeHint?: boolean;
}

const defaultRedactedMessage = (status: number, catalog: Catalog<string>): string => {
  const code = STATUS_TO_CODE[status];
  return (code && catalog.get(code)?.title) || 'Internal Server Error';
};

/**
 * THE single wire-redaction seam. Every transport edge (HTTP, WS, live, queue
 * reporting) builds its client-bound error content here, so the invariant
 * "unbranded or internal-coded errors never echo their message" holds
 * identically everywhere. `redacted: true` is the caller's signal to log the
 * raw error server-side — this function never logs (zero-dep purity).
 */
export const toErrorBody = (error: unknown, options: ToErrorBodyOptions = {}): ErrorBodyResult => {
  const catalog = options.catalog ?? CORE_CATALOG;
  const message = options.redactedMessage ?? ((s: number) => defaultRedactedMessage(s, catalog));

  const redact = (status: number, code: string): ErrorBodyResult => ({
    body: { error: { code, message: message(status) } },
    status,
    redacted: true,
  });

  if (!isVelaError(error)) {
    const status = options.fallbackStatus ?? 500;
    return redact(status, STATUS_TO_CODE[status] ?? 'internal');
  }

  const entry = catalog.get(error.code);
  if (error.code === 'internal' || entry?.internal === true) {
    return redact(error.status, error.code);
  }

  const wire: WireErrorObject = { code: error.code, message: error.message };
  const hint = error.hint ?? entry?.hint;
  if (options.includeHint !== false && hint !== undefined) wire.hint = hint;
  const docsUrl = error.docsUrl ?? entry?.docsUrl;
  if (docsUrl !== undefined) wire.docsUrl = docsUrl;
  if (error.data !== undefined)
    wire.details = options.encodeData ? options.encodeData(error.data) : error.data;
  return { body: { error: wire }, status: error.status, redacted: false };
};

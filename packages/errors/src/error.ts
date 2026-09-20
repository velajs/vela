import { CORE_ENTRIES, type CoreErrorCode } from './catalog-data';

export interface VelaErrorOptions {
  message?: string;
  status?: number;
  hint?: string;
  docsUrl?: string;
  data?: unknown;
  cause?: unknown;
}

/**
 * The one Vela error. Every field is an OWN ENUMERABLE property so the error
 * rides any wire codec / structuredClone / DO-RPC prop-copy with no special
 * serialization path. `type` is the brand `isVelaError` checks — it must
 * survive serialization, which own+enumerable guarantees.
 */
export class VelaError extends Error {
  readonly type = 'VelaError';
  readonly code: string;
  readonly status: number;
  readonly hint?: string;
  readonly docsUrl?: string;
  readonly data?: unknown;

  constructor(code: CoreErrorCode, options?: VelaErrorOptions);
  constructor(code: string, options: VelaErrorOptions & { status: number });
  constructor(code: string, options: VelaErrorOptions = {}) {
    const entry = (
      CORE_ENTRIES as Record<
        string,
        { status: number; title: string; hint?: string; docsUrl?: string }
      >
    )[code];
    super(
      options.message ?? entry?.title ?? code,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'VelaError';
    this.code = code;
    this.status = options.status ?? entry?.status ?? 500;
    const hint = options.hint ?? entry?.hint;
    const docsUrl = options.docsUrl ?? entry?.docsUrl;
    if (hint !== undefined) this.hint = hint;
    if (docsUrl !== undefined) this.docsUrl = docsUrl;
    if (options.data !== undefined) this.data = options.data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

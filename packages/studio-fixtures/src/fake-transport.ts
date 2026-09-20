/**
 * A framework-free fake transport for Studio tests. It implements the same
 * `rpc<Op>(op, args)` seam the real `AdminClient` exposes (structurally the UI's
 * `TransportLike`), backed by a typed table of canned responses. Typed entirely
 * by `@velajs/studio-protocol`, so it is a drift guard: the table stops compiling
 * if the wire contract moves.
 */
import type { AdminErrorBody, StudioOp, StudioOpReq, StudioOpRes } from '@velajs/studio-protocol';
import { parseStudioResponse } from '@velajs/studio-protocol';

/** A canned responder for one op: a value, or a (possibly async) function of args. */
export type FakeResponder<Op extends StudioOp> =
  | ((args: StudioOpReq<Op>) => StudioOpRes<Op> | Promise<StudioOpRes<Op>>)
  | StudioOpRes<Op>;

/** The typed table of canned responses, keyed by op. */
export type FakeTransportTable = Partial<{ [Op in StudioOp]: FakeResponder<Op> }>;

/** Options controlling simulated latency and forced error envelopes. */
export interface FakeTransportOptions {
  /** Artificial latency (ms) applied before each resolution/rejection. */
  latencyMs?: number;
  /** Ops that reject with a canned error body instead of resolving. */
  errors?: Partial<Record<StudioOp, AdminErrorBody>>;
}

/** One recorded dispatch, for assertions on call counts / ordering. */
export interface FakeTransportCall {
  op: StudioOp;
  args: unknown;
}

/**
 * An error carrying a wire {@link AdminErrorBody}. Structurally mirrors the UI's
 * `AdminError` (`body` + `status`) so the query hooks' `toAdminError` seam
 * re-wraps it into a real `AdminError` without a cross-package dependency.
 */
export class FakeAdminError extends Error {
  readonly body: AdminErrorBody;
  readonly status: number;

  constructor(body: AdminErrorBody, status: number = body.status) {
    super(body.message);
    this.name = 'FakeAdminError';
    this.body = body;
    this.status = status;
  }
}

/** Build a minimal {@link AdminErrorBody}; `title`/`message` default to `code`. */
export function makeErrorBody(
  code: string,
  status: number,
  overrides: Partial<AdminErrorBody> = {},
): AdminErrorBody {
  return {
    code,
    title: overrides.title ?? code,
    status,
    message: overrides.message ?? code,
    ...overrides,
  };
}

const unknownOpBody = (op: string): AdminErrorBody =>
  makeErrorBody('STUDIO_UNKNOWN_OP', 404, {
    title: 'Unknown op',
    message: `No canned response registered for op "${op}".`,
    hint: 'Add it to the FakeAdminTransport table.',
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A transport driven by a canned table. Unknown ops reject with a
 * `STUDIO_UNKNOWN_OP` (404) {@link FakeAdminError}; the `errors`/`latencyMs`
 * options simulate failure envelopes and slow links.
 */
export class FakeAdminTransport {
  /** Every dispatch this transport has seen, in order. */
  readonly calls: FakeTransportCall[] = [];
  // Stored loosely: writing into a per-op mapped index under a generic `Op`
  // makes the compiler compute a union too complex to represent (TS2590). The
  // public constructor/`setResponder`/`rpc` signatures stay fully op-typed.
  #table: Partial<Record<StudioOp, unknown>>;
  #options: FakeTransportOptions;

  constructor(table: FakeTransportTable = {}, options: FakeTransportOptions = {}) {
    this.#table = { ...table };
    this.#options = options;
  }

  /** Register (or replace) the canned responder for a single op. */
  setResponder<Op extends StudioOp>(op: Op, responder: FakeResponder<Op>): void {
    this.#table[op] = responder;
  }

  async rpc<Op extends StudioOp>(
    op: Op,
    args: StudioOpReq<Op>,
    _opts?: { signal?: AbortSignal },
  ): Promise<StudioOpRes<Op>> {
    this.calls.push({ op, args });
    if (this.#options.latencyMs !== undefined) await delay(this.#options.latencyMs);

    const forced = this.#options.errors?.[op];
    if (forced !== undefined) throw new FakeAdminError(forced);

    const responder = this.#table[op];
    if (responder === undefined) throw new FakeAdminError(unknownOpBody(op));

    const value: unknown = typeof responder === 'function' ? await responder(args) : responder;
    return parseStudioResponse(op, value);
  }
}

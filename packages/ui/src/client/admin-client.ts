/**
 * The browser transport for Vela Studio. Framework-free (no React): a thin
 * `fetch` client that POSTs the {@link AdminRpcRequest} envelope and unwraps the
 * discriminated {@link AdminRpcResponse}. Every wire shape is imported from
 * `@velajs/studio-protocol`; this module never declares its own.
 */
import type {
  AdminErrorBody,
  AdminRpcResponse,
  StudioOp,
  StudioRpcMap,
} from '@velajs/studio-protocol';
import {
  STUDIO_DEFAULT_PATH,
  STUDIO_HEALTH_SUFFIX,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_RPC_SUFFIX,
} from '@velajs/studio-protocol';

/**
 * The transport seam the data layer depends on. Both {@link AdminClient} (real
 * `fetch`) and the test `FakeAdminTransport` implement it, so fixtures slot in
 * wherever a `TransportLike` is expected.
 */
export interface TransportLike {
  rpc<Op extends StudioOp>(
    op: Op,
    args: StudioRpcMap[Op]['req'],
    opts?: { signal?: AbortSignal },
  ): Promise<StudioRpcMap[Op]['res']>;
}

/** Construction options for {@link AdminClient}. */
export interface AdminClientOptions {
  /** Origin the admin surface is served from (e.g. `https://app.example.com`). */
  baseUrl: string;
  /** The master bearer token; may be set later via {@link AdminClient.setToken}. */
  adminToken?: string;
  /** Reserved mount prefix; defaults to {@link STUDIO_DEFAULT_PATH}. */
  basePath?: string;
  /** Injectable `fetch` (tests / non-browser runtimes). Defaults to global. */
  fetchImpl?: typeof fetch;
}

/**
 * A failed dispatch, carrying the wire {@link AdminErrorBody} and HTTP `status`
 * verbatim so the UI can render `title`/`hint`/`docsUrl` straight off the error.
 */
export class AdminError extends Error {
  readonly body: AdminErrorBody;
  readonly status: number;

  constructor(body: AdminErrorBody, status: number = body.status) {
    super(body.message);
    this.name = 'AdminError';
    this.body = body;
    this.status = status;
  }

  get code(): string {
    return this.body.code;
  }
  get hint(): string | undefined {
    return this.body.hint;
  }
  get docsUrl(): string | undefined {
    return this.body.docsUrl;
  }
}

const syntheticBody = (
  code: string,
  status: number,
  title: string,
  message: string,
): AdminErrorBody => ({ code, title, status, message });

interface ErrorBodyCarrier {
  body: AdminErrorBody;
  status?: number;
}

function isErrorBodyCarrier(err: unknown): err is ErrorBodyCarrier {
  if (typeof err !== 'object' || err === null || !('body' in err)) return false;
  const body = (err as { body: unknown }).body;
  return typeof body === 'object' && body !== null && 'code' in body && 'status' in body;
}

/**
 * Coerce an unknown thrown value into an {@link AdminError}. Recognizes real
 * `AdminError`s, any transport that carries a wire `body` (e.g. the test
 * `FakeAdminTransport`), aborts, and bare network failures.
 */
export function toAdminError(err: unknown): AdminError {
  if (err instanceof AdminError) return err;
  if (isErrorBodyCarrier(err)) return new AdminError(err.body, err.status ?? err.body.status);
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AdminError(syntheticBody('STUDIO_ABORTED', 0, 'Request aborted', err.message), 0);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AdminError(syntheticBody('STUDIO_TRANSPORT_ERROR', 0, 'Transport error', message), 0);
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * The default browser transport. `rpc` POSTs `{ args }` to
 * `${baseUrl}${basePath}${STUDIO_RPC_SUFFIX}${op}` (adding `Authorization: Bearer`
 * when a token is set), unwraps `ok: true → data`, and throws {@link AdminError}
 * on `ok: false` or any non-JSON / network failure.
 */
export class AdminClient implements TransportLike {
  #baseUrl: string;
  #basePath: string;
  #token: string | undefined;
  #fetch: typeof fetch;

  constructor(options: AdminClientOptions) {
    this.#baseUrl = stripTrailingSlash(options.baseUrl);
    this.#basePath = options.basePath ?? STUDIO_DEFAULT_PATH;
    this.#token = options.adminToken;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Replace the bearer token (or clear it with `undefined`). */
  setToken(token: string | undefined): void {
    this.#token = token;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.#token !== undefined && this.#token !== '') {
      headers.authorization = `Bearer ${this.#token}`;
    }
    return headers;
  }

  async rpc<Op extends StudioOp>(
    op: Op,
    args: StudioRpcMap[Op]['req'],
    opts?: { signal?: AbortSignal },
  ): Promise<StudioRpcMap[Op]['res']> {
    const url = `${this.#baseUrl}${this.#basePath}${STUDIO_RPC_SUFFIX}${op}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ args }),
        signal: opts?.signal,
      });
    } catch (err) {
      throw toAdminError(err);
    }
    return this.#unwrap<Op>(op, response);
  }

  async #unwrap<Op extends StudioOp>(op: Op, response: Response): Promise<StudioRpcMap[Op]['res']> {
    const status = response.status || 0;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AdminError(
        syntheticBody(
          'STUDIO_BAD_RESPONSE',
          status,
          'Malformed response',
          `Non-JSON response for "${op}".`,
        ),
        status,
      );
    }
    if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
      const envelope = payload as AdminRpcResponse<StudioRpcMap[Op]['res']>;
      if (envelope.ok) return envelope.data;
      throw new AdminError(envelope.error, envelope.status);
    }
    throw new AdminError(
      syntheticBody(
        'STUDIO_BAD_RESPONSE',
        status,
        'Malformed response',
        `Missing ok envelope for "${op}".`,
      ),
      status,
    );
  }

  /** Unauthenticated health probe (`GET {prefix}/health`). */
  async health(): Promise<{ enabled: boolean; protocolVersion: number }> {
    const url = `${this.#baseUrl}${this.#basePath}${STUDIO_HEALTH_SUFFIX}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (err) {
      throw toAdminError(err);
    }
    const status = response.status || 0;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AdminError(
        syntheticBody(
          'STUDIO_BAD_RESPONSE',
          status,
          'Malformed response',
          'Non-JSON health response.',
        ),
        status,
      );
    }
    const body = (payload ?? {}) as Partial<{ enabled: boolean; protocolVersion: number }>;
    return {
      enabled: Boolean(body.enabled),
      protocolVersion:
        typeof body.protocolVersion === 'number' ? body.protocolVersion : STUDIO_PROTOCOL_VERSION,
    };
  }
}

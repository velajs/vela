/* eslint-disable no-await-in-loop -- Retry attempts and their backoff must execute sequentially. */
import type { AnyProcedure, ProcedureOutput, ProcedureWireInput } from './contract';
import { createDeadline, readJson, withSignal } from './deadline';
import { assertJson, parseRpcRequest, parseRpcResponse, RpcProtocolError } from './protocol';
import type { JsonValue, RpcFailure, RpcRequest, RpcSuccess } from './protocol';

export interface RpcFetcher {
  fetch(request: Request): Promise<Response>;
}
export interface RpcClientOptions {
  /** Full endpoint URL, including any application prefix. */
  url: string | URL;
  /** Native service binding, application fetch adapter, or the browser fetch function. */
  fetch?: RpcFetcher | ((request: Request) => Promise<Response>);
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface RpcCallOptions<Output> {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: HeadersInit;
  retry?: { maxAttempts: number; delayMs?: number };
  /** Independent wire-result validator. Never reuse a transforming server output schema. */
  decode?: (value: JsonValue) => Output | Promise<Output>;
}
export class RpcError extends Error {
  readonly code: string;
  readonly status: number;
  readonly id: string;
  readonly procedure: string;
  constructor(response: RpcFailure) {
    super(response.error.message);
    this.name = 'RpcError';
    this.code = response.error.code;
    this.status = response.error.status;
    this.id = response.id;
    this.procedure = response.procedure;
  }
}
export class RpcHttpError extends Error {
  constructor(readonly status: number) {
    super(`RPC transport returned HTTP ${status}`);
    this.name = 'RpcHttpError';
  }
}
class NetworkFailure extends Error {
  constructor(cause: unknown) {
    super('RPC transport failed', { cause });
  }
}

export class RpcClient {
  readonly #url: string;
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #options: RpcClientOptions;
  readonly #maxBytes: number;

  constructor(options: RpcClientOptions) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new TypeError('RPC requires an HTTP(S) endpoint without credentials or fragment');
    this.#url = url.href;
    this.#options = { ...options };
    const transport = options.fetch;
    this.#fetch =
      transport === undefined
        ? (request) => fetch(request)
        : typeof transport === 'function'
          ? transport
          : (request) => transport.fetch(request);
    this.#maxBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1)
      throw new RangeError('RPC maxResponseBytes must be a positive integer');
  }

  async call<P extends AnyProcedure>(
    procedure: P,
    input: NoInfer<ProcedureWireInput<P>>,
    options: RpcCallOptions<NoInfer<ProcedureOutput<P>>> = {},
  ): Promise<ProcedureOutput<P>> {
    assertJson(input);
    const request = parseRpcRequest({
      version: 1,
      id: crypto.randomUUID(),
      procedure: procedure.name,
      input,
    });
    const attempts = options.retry?.maxAttempts ?? 1;
    const delay = options.retry?.delayMs ?? 100;
    if (
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 5 ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 60_000
    )
      throw new RangeError('Invalid RPC retry policy');
    if (attempts > 1 && !procedure.idempotent)
      throw new TypeError('RPC retries require an explicitly idempotent procedure');
    const deadline = createDeadline(
      options.timeoutMs ?? this.#options.timeoutMs ?? 30_000,
      options.signal,
    );
    try {
      const defaults = this.#options.headers;
      const headers = new Headers(
        await withSignal(
          Promise.resolve(typeof defaults === 'function' ? defaults() : defaults),
          deadline.signal,
        ),
      );
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
      headers.set('content-type', 'application/json');
      headers.set('accept', 'application/json');
      let response: RpcSuccess | undefined;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        deadline.signal.throwIfAborted();
        try {
          response = await this.#send(request, headers, deadline.signal);
          break;
        } catch (error) {
          deadline.signal.throwIfAborted();
          // An application error is final, even when its status is 503.
          const retryable =
            error instanceof NetworkFailure ||
            (error instanceof RpcHttpError && [502, 503, 504].includes(error.status));
          if (attempt === attempts || !retryable)
            throw error instanceof NetworkFailure ? error.cause : error;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await withSignal(
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, delay);
              }),
              deadline.signal,
            );
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      }
      if (!response) throw new RpcProtocolError('RPC attempt did not produce a result');
      if (options.decode)
        return await withSignal(
          Promise.resolve().then(() => options.decode!(response.result)),
          deadline.signal,
        );
      // The envelope and JSON are checked. Domain shape relies on the matching
      // server contract; decode is the independent boundary for untrusted peers.
      return response.result as ProcedureOutput<P>;
    } finally {
      deadline.dispose();
    }
  }

  async #send(rpc: RpcRequest, headers: Headers, signal: AbortSignal): Promise<RpcSuccess> {
    const request = new Request(this.#url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc),
      signal,
      ...(this.#options.credentials === undefined
        ? {}
        : { credentials: this.#options.credentials }),
    });
    let response: Response;
    const pending = Promise.resolve().then(() => this.#fetch(request));
    // A transport ignoring abort may resolve late; release its unused body.
    void pending.then(
      (value) => {
        if (signal.aborted) void value.body?.cancel().catch(() => {});
        return undefined;
      },
      () => {},
    );
    try {
      response = await withSignal(pending, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new NetworkFailure(error);
    }
    if (
      (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0]?.trim() !==
      'application/json'
    ) {
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new RpcHttpError(response.status);
      throw new RpcProtocolError('RPC response must be application/json');
    }
    const body = await readJson(response, signal, this.#maxBytes);
    let envelope;
    try {
      envelope = parseRpcResponse(body, rpc);
    } catch (error) {
      // An apparent RPC frame with a wrong ID/version/outcome is a protocol
      // failure, even on a gateway status. Do not retry a miscorrelated reply.
      const framed =
        body !== null &&
        typeof body === 'object' &&
        ('version' in body || 'id' in body || 'procedure' in body || 'ok' in body);
      if (!response.ok && !framed) throw new RpcHttpError(response.status);
      throw error;
    }
    if (!envelope.ok) {
      if (response.status !== envelope.error.status)
        throw new RpcProtocolError('RPC error status mismatch');
      throw new RpcError(envelope);
    }
    if (response.status !== 200) throw new RpcProtocolError('RPC success requires HTTP 200');
    return envelope;
  }
}
export function createRpcClient(options: RpcClientOptions): RpcClient {
  return new RpcClient(options);
}

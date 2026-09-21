import { VelaError } from '@velajs/errors';
import type { VelaErrorOptions } from '@velajs/errors';
import { CONFIG_ENV } from '../config/config.tokens';
import { Container } from '../container/container';
import { Inject, Injectable, Optional } from '../container/decorators';
import { sha256Base64Url } from '../crypto/hmac';
import {
  INVOCATION_AUDIENCE,
  INVOCATION_DEFAULT_TTL_SECONDS,
  signInvocation,
} from '../crypto/invocation';
import type { InvocationClaim } from '../crypto/invocation';
import type { RouteName } from '../http/route-map';
import { URL_SIGNING_SECRET, resolveSigningSecret } from '../http/url/signing-secret';
import { UrlGeneratorService } from '../http/url/url-generator.service';
import { abortDeadline } from './abort-deadline';
import { INVOCATION_HEADER, INVOCATION_SIGNING_SECRET, INVOCATION_TRANSPORT } from './tokens';
import type {
  InvocationPathTarget,
  InvocationRouteTarget,
  InvocationTransport,
  RunInit,
} from './types';

// Only pathname + search matter to routing and to the guard, so the origin is
// arbitrary — but it must be a valid absolute base for `new URL`/`new Request`.
const INVOCATION_ORIGIN = 'http://vela.internal';

/** Default bound for the transport plus its complete response-body read. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

interface WireError {
  code?: string;
  message?: string;
  hint?: string;
  docsUrl?: string;
  details?: unknown;
}

function extractWireError(body: unknown): WireError | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const wire: WireError = {};
  if (typeof e.code === 'string') wire.code = e.code;
  if (typeof e.message === 'string') wire.message = e.message;
  if (typeof e.hint === 'string') wire.hint = e.hint;
  if (typeof e.docsUrl === 'string') wire.docsUrl = e.docsUrl;
  if ('details' in e) wire.details = e.details;
  return wire;
}

/**
 * Race an operation against `signal`. The operation keeps its rejection
 * handler after an abort, so a late failure cannot become unhandled.
 */
function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: (reason: unknown) => void | PromiseLike<void>,
): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      continuation();
    };

    const handleAbort = () => {
      settle(() => {
        try {
          void Promise.resolve(onAbort?.(signal.reason)).catch(() => {});
        } catch {
          // Cancellation is best-effort; the abort reason remains authoritative.
        }
        reject(signal.reason);
      });
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/** Read and decode the body while actively cancelling its reader on abort. */
async function readResponseText(response: Response, signal: AbortSignal | undefined) {
  const body = response.body;
  if (body === null) {
    signal?.throwIfAborted();
    return '';
  }

  if (signal?.aborted === true) {
    await body.cancel(signal.reason).catch(() => {});
    signal.throwIfAborted();
  }

  const reader = body.getReader();
  const readAll = async () => {
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    while (true) {
      // Body chunks are ordered; each read necessarily waits for the previous one.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  };

  try {
    return await raceWithAbort(readAll(), signal, (reason) => reader.cancel(reason));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancellation may still be settling; the reader was already cancelled.
    }
  }
}

/**
 * `ctx.run` for a route/module-shaped framework: an injectable service that
 * re-enters the app through a per-invocation SIGNED route. Any queue / cron /
 * (future) workflow handler resolving this from its scope can call back into a
 * `@SignedInvocation()` route without a shared bearer token — the signature IS
 * the authorization.
 *
 * Signing is ALWAYS applied and the transport ALWAYS runs the request pipeline,
 * so verification happens whether the delivery is the in-isolate `app.fetch`
 * short-circuit (default) or a cross-isolate service-binding fetch (adapter).
 * The short-circuit skips only the network hop, never the guard.
 */
@Injectable()
export class InternalDispatcher {
  readonly #invocationSecret: string | undefined;
  readonly #urlSecret: string | undefined;
  readonly #env: Record<string, unknown>;

  constructor(
    @Inject(UrlGeneratorService) private readonly urls: UrlGeneratorService,
    @Inject(Container) private readonly container: Container,
    @Optional() @Inject(INVOCATION_SIGNING_SECRET) invocationSecret?: string,
    @Optional() @Inject(URL_SIGNING_SECRET) urlSecret?: string,
    @Optional() @Inject(CONFIG_ENV) env: Record<string, unknown> = {},
  ) {
    this.#invocationSecret = invocationSecret;
    this.#urlSecret = urlSecret;
    this.#env = env;
  }

  /**
   * Sign and dispatch an internal invocation, returning the parsed JSON body.
   *
   * A non-2xx response is reconstructed into a `VelaError` carrying the
   * upstream status, so callers can branch deterministic 4xx (non-retryable)
   * from transient 5xx (retryable) — the mapping `@velajs/workflow` uses for
   * `NonRetryableError`.
   *
   * @throws if a named route is unknown or a required param is missing
   *   (`UrlGeneratorService.urlFor`), if no signing secret is configured
   *   (`resolveSigningSecret`), if `timeoutMs` is invalid, if the caller aborts,
   *   or if the dispatch times out / returns a non-2xx or non-JSON response.
   */
  async run<T = unknown, N extends RouteName = RouteName>(
    target: InvocationRouteTarget<N> | InvocationPathTarget,
    init: RunInit = {},
  ): Promise<T> {
    const timeoutMs = init.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        'InternalDispatcher.run() timeoutMs must be a finite number greater than zero.',
      );
    }
    init.signal?.throwIfAborted();

    const requestedPath =
      'route' in target ? this.urls.urlFor(target.route, target.params) : target.path;

    // Normalize so the claim's `path` is EXACTLY what the guard recomputes from
    // the delivered request (`pathname + search`), regardless of formatting.
    const url = new URL(requestedPath, INVOCATION_ORIGIN);
    const path = `${url.pathname}${url.search}`;

    const secret = resolveSigningSecret(this.#invocationSecret, this.#urlSecret, this.#env);

    const method = (init.method ?? 'POST').toUpperCase();
    const hasBody = init.body !== undefined;
    const bodyText = hasBody ? JSON.stringify(init.body) : '';
    const bodyHash = hasBody ? await sha256Base64Url(new TextEncoder().encode(bodyText)) : '';

    const claim: InvocationClaim = {
      aud: INVOCATION_AUDIENCE,
      method,
      path,
      bodyHash,
      exp: Math.floor(Date.now() / 1000) + (init.ttlSeconds ?? INVOCATION_DEFAULT_TTL_SECONDS),
      nonce: crypto.randomUUID(),
      ...(init.iss !== undefined ? { iss: init.iss } : {}),
    };
    const token = await signInvocation(claim, secret);

    const headers = new Headers(init.headers);
    headers.set(INVOCATION_HEADER, token);
    if (hasBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const deadline = abortDeadline(
      init.signal,
      timeoutMs,
      () => new DOMException('Internal dispatch deadline exceeded.', 'TimeoutError'),
    );

    try {
      deadline.signal?.throwIfAborted();
      const request = new Request(url, {
        method,
        headers,
        signal: deadline.signal,
        ...(hasBody ? { body: bodyText } : {}),
      });
      const transport = this.resolveTransport();
      const response = await raceWithAbort(
        Promise.resolve().then(() => transport(request)),
        deadline.signal,
      );
      return await this.parseResponse<T>(response, deadline.signal);
    } catch (error: unknown) {
      if (deadline.timedOut()) {
        throw new VelaError('gateway_timeout', {
          message: `Internal invocation timed out after ${timeoutMs}ms.`,
          cause: error,
        });
      }
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  private resolveTransport(): InvocationTransport {
    try {
      return this.container.resolve(INVOCATION_TRANSPORT);
    } catch {
      throw new VelaError('internal', {
        message:
          'Internal invocation transport is not registered — InternalDispatcher.run() ' +
          'must be called after the application has finished building.',
      });
    }
  }

  private async parseResponse<T>(response: Response, signal: AbortSignal | undefined): Promise<T> {
    const text = await readResponseText(response, signal);

    if (response.ok) {
      if (text === '') return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new VelaError('internal', {
          message: 'Internal invocation returned a non-JSON body.',
        });
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    throw this.toInvocationError(response.status, body);
  }

  private toInvocationError(status: number, body: unknown): VelaError {
    const wire = extractWireError(body);
    const code = wire?.code ?? (status >= 500 ? 'internal' : 'bad_request');
    const options: VelaErrorOptions & { status: number } = { status };
    if (wire?.message !== undefined) options.message = wire.message;
    if (wire?.hint !== undefined) options.hint = wire.hint;
    if (wire?.docsUrl !== undefined) options.docsUrl = wire.docsUrl;
    if (wire?.details !== undefined) options.data = wire.details;
    return new VelaError(code, options);
  }
}

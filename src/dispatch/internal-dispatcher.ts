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
  constructor(
    @Inject(UrlGeneratorService) private readonly urls: UrlGeneratorService,
    @Inject(Container) private readonly container: Container,
    @Optional() @Inject(INVOCATION_SIGNING_SECRET) private readonly invocationSecret?: string,
    @Optional() @Inject(URL_SIGNING_SECRET) private readonly urlSecret?: string,
    @Optional() @Inject(CONFIG_ENV) private readonly env: Record<string, unknown> = {},
  ) {}

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
   *   (`resolveSigningSecret`), or if the response is non-2xx / non-JSON.
   */
  async run<T = unknown, N extends RouteName = RouteName>(
    target: InvocationRouteTarget<N> | InvocationPathTarget,
    init: RunInit = {},
  ): Promise<T> {
    const requestedPath =
      'route' in target ? this.urls.urlFor(target.route, target.params) : target.path;

    // Normalize so the claim's `path` is EXACTLY what the guard recomputes from
    // the delivered request (`pathname + search`), regardless of formatting.
    const url = new URL(requestedPath, INVOCATION_ORIGIN);
    const path = `${url.pathname}${url.search}`;

    const secret = resolveSigningSecret(this.invocationSecret, this.urlSecret, this.env);

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

    const request = new Request(url, {
      method,
      headers,
      ...(hasBody ? { body: bodyText } : {}),
    });

    const response = await this.resolveTransport()(request);
    return this.parseResponse<T>(response);
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

  private async parseResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      const text = await response.text();
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
      body = await response.json();
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

import { Scope } from '../constants';
import type { Container } from '../container/container';
import { defineProvider, InjectionToken } from '../container/types';
import { getExecutionLifetime } from '../entrypoint/execution-scope';
import type { RuntimeAdapter } from '../factory/adapter';
import { findRequestContainer } from '../http/request-container';
import type { RequestContext } from '../http/request-context';
import { extractTraceContext } from './trace-context';
import { noopScopedTelemetry, safeTelemetry, telemetryHttpMethod } from './telemetry';
import type { ScopedTelemetry, Telemetry, TelemetryAttributes } from './types';

export const REQUEST_TELEMETRY = /* @__PURE__ */ new InjectionToken<ScopedTelemetry>(
  'vela.RequestTelemetry',
);

/** Outside an active instrumented invocation, return an inert handle. */
export function telemetryForScope(container: Container): ScopedTelemetry {
  return getExecutionLifetime(container) && container.has(REQUEST_TELEMETRY)
    ? container.resolve(REQUEST_TELEMETRY)
    : noopScopedTelemetry;
}

export function getRequestTelemetry(context: RequestContext): ScopedTelemetry {
  const container = findRequestContainer(context.hono);
  return container ? telemetryForScope(container) : noopScopedTelemetry;
}

export interface ObservabilityOptions {
  readonly telemetry?: Telemetry;
  /** Opt in only at an ingress allowed to join caller-supplied traces. Defaults to false. */
  readonly trustIncomingTraceContext?: boolean;
}

/** Install once per application. Does not configure exporters, timers, or ambient context. */
export function observabilityAdapter(options: ObservabilityOptions = {}): RuntimeAdapter {
  const telemetry = safeTelemetry(options.telemetry);
  const trustIncoming = options.trustIncomingTraceContext === true;
  const requests = telemetry.createCounter('http.server.request.count', { unit: '{request}' });
  const duration = telemetry.createHistogram('http.server.request.duration', { unit: 's' });
  return {
    name: 'observability',
    configureContainer(container) {
      if (container.has(REQUEST_TELEMETRY)) {
        throw new Error('Configure observabilityAdapter only once per application.');
      }
      container.register(
        defineProvider(REQUEST_TELEMETRY, {
          scope: Scope.REQUEST,
          useFactory: () => noopScopedTelemetry,
        }),
      );
      container.markGlobalToken(REQUEST_TELEMETRY);
    },
    onBootstrap({ routeManager }) {
      routeManager.observeRequests((context, container) => {
        const method = telemetryHttpMethod(context.req.method);
        const span = telemetry.startSpan(`HTTP ${method}`, {
          kind: 'server',
          parent: trustIncoming ? extractTraceContext(context.req.raw.headers) : undefined,
          attributes: { 'http.request.method': method },
        });
        container.setRequestInstance(REQUEST_TELEMETRY, Object.freeze({ telemetry, span }));
        let completed = false;
        return {
          complete(completion) {
            if (completed) return;
            completed = true;
            const attributes: TelemetryAttributes = Object.freeze({
              'http.request.method': method,
              ...(completion.route ? { 'http.route': completion.route } : {}),
              ...(completion.status === undefined
                ? {}
                : { 'http.response.status_code': completion.status }),
              'vela.outcome': completion.outcome,
            });
            span.setAttributes(attributes);
            span.end(completion.outcome);
            requests.add(1, attributes);
            duration.record(completion.durationMs / 1000, attributes);
          },
        };
      });
    },
  };
}

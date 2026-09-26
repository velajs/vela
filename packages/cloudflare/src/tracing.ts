import { tracing } from 'cloudflare:workers';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@velajs/vela';

const MAX_LABEL_LENGTH = 128;

/**
 * Native Workers spans around awaited HTTP/RPC handler work. Register through
 * `@UseInterceptors(CloudflareTracingInterceptor)` on a controller or RPC host.
 *
 * The callback establishes the native async parent for inner interceptors,
 * handler code and awaited platform calls. Guards/pipes run before it; response
 * streams, deferred work and scope disposal can outlive it. Cloudflare owns
 * sampling, ending and export. This is not a portable Telemetry recorder.
 */
@Injectable()
export class CloudflareTracingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const kind = context.getType();
    if (kind !== 'http' && kind !== 'rpc') return next.handle();

    return tracing.enterSpan(kind === 'http' ? 'vela.http.handler' : 'vela.rpc.handler', (span) => {
      if (span.isTraced) {
        span.setAttribute('vela.handler.class', context.getClass().name.slice(0, MAX_LABEL_LENGTH));
        const method = context.getHandlerName();
        // Symbol descriptions may contain caller data; only declared string
        // method names belong in these fixed, bounded instrumentation labels.
        if (typeof method === 'string') {
          span.setAttribute('vela.handler.method', method.slice(0, MAX_LABEL_LENGTH));
        }
      }
      // Return the actual handler promise from INSIDE enterSpan. Starting a
      // span in an onStart observer would lose native parent-child nesting.
      return next.handle();
    });
  }
}

/** Optional, application-owned structured log capture. No console patching or ambient state. */
import { APP_INTERCEPTOR, defineProvider } from '@velajs/vela';
import { APP_LOGGER } from '@velajs/vela/logging';
import { describeToken, getExecutionLifetime, type Container } from '@velajs/vela/module-kit';
import { STUDIO_APPLICATION_CONTAINER } from '../tokens';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
} from '@velajs/vela';
import type { ApplicationLogger, LogRecord } from '@velajs/vela/logging';
import { parseStudioInvocationDiagnostic } from '@velajs/studio-protocol';
import type { AdminLogEntry, StudioInvocationDiagnostic } from '@velajs/studio-protocol';
import { AdminLogBuffer } from '../logs/log-buffer';
import { defineStudioPlugin, type StudioPlugin } from '../plugin';

export interface LogsPanelOptions {
  /** Record handler/inner-interceptor completion; excludes transport and deferred work. Default false. */
  timings?: boolean;
}

const LEVELS: Record<LogRecord['level'], AdminLogEntry['level']> = {
  LOG: 'info',
  ERROR: 'error',
  WARN: 'warn',
  DEBUG: 'debug',
  VERBOSE: 'debug',
};

/** Subscribes once on initialization and detaches when its application closes. */
export class StudioLogCapture implements OnModuleInit, OnModuleDestroy {
  #unsubscribe: (() => void) | undefined;
  constructor(
    readonly logger: ApplicationLogger,
    readonly buffer: AdminLogBuffer,
  ) {}

  onModuleInit(): void {
    this.#unsubscribe ??= this.logger.subscribe((record) => {
      let invocation: StudioInvocationDiagnostic | undefined;
      if (record.category === 'studio.invocation') {
        try {
          invocation = parseStudioInvocationDiagnostic(record.fields.studioInvocation);
        } catch {
          /* Unrecognized application fields remain ordinary log data. */
        }
      }
      this.buffer.record({
        ts: record.timestamp,
        level: LEVELS[record.level],
        source: record.category,
        msg: record.message,
        fields: {
          ...record.fields,
          ...(record.arguments.length ? { arguments: record.arguments } : {}),
        },
        ...(invocation === undefined ? {} : { invocation }),
      });
    });
  }

  onModuleDestroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

/** Portable interceptor: measures next.handle(), never response-body or background completion. */
export class StudioTimingInterceptor implements NestInterceptor {
  constructor(
    readonly logger: ApplicationLogger,
    readonly enabled = false,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    if (!this.enabled) return next.handle();
    const start = performance.now();
    let outcome: StudioInvocationDiagnostic['outcome'] = 'returned';
    try {
      return await next.handle();
    } catch (error) {
      outcome = 'threw';
      throw error;
    } finally {
      const scope = context.getContainer();
      const lifetime = scope === undefined ? undefined : getExecutionLifetime(scope);
      const moduleId = context.getModuleId();
      const invocation: StudioInvocationDiagnostic = {
        kind: context.getType(),
        source: `${describeToken(context.getClass())}#${String(context.getHandlerName())}`,
        elapsedMs: Math.max(0, performance.now() - start),
        outcome,
        boundary: 'handler',
        ...(moduleId === undefined ? {} : { moduleId }),
        ...(lifetime === undefined ? {} : { invocationId: lifetime.id }),
      };
      // Error details are reported once at the transport's reporter boundary.
      this.logger
        .createLogger(
          'studio.invocation',
          { studioInvocation: invocation },
          lifetime === undefined ? {} : { waitUntil: (work) => lifetime.waitUntil(work) },
        )
        .log(`Handler ${outcome}`);
    }
  }
}

/** The application's `APP_LOGGER`, which `LoggingModule.forRoot()` provides. */
function applicationLogger(container: Container): ApplicationLogger {
  if (!container.has(APP_LOGGER)) {
    throw new Error(
      'logsPanel() captures the application logger: import LoggingModule.forRoot() from ' +
        '@velajs/vela/logging in the application.',
    );
  }
  return container.resolve(APP_LOGGER);
}

/**
 * The logs panel: captures the application's normalized, redacted structured
 * records (from `LoggingModule`) into Studio's log buffer, and optionally the
 * handler timings: `StudioModule.forRoot({ plugins: [logsPanel({ timings: true })] })`.
 */
export function logsPanel(options: LogsPanelOptions = {}): StudioPlugin {
  const timings = options.timings === true;
  return defineStudioPlugin({
    name: 'logs',
    providers: [
      defineProvider(StudioLogCapture, {
        inject: [STUDIO_APPLICATION_CONTAINER, AdminLogBuffer],
        useFactory: (container, buffer) =>
          new StudioLogCapture(applicationLogger(container), buffer),
      }),
      defineProvider(StudioTimingInterceptor, {
        inject: [STUDIO_APPLICATION_CONTAINER],
        useFactory: (container) =>
          new StudioTimingInterceptor(applicationLogger(container), timings),
      }),
      defineProvider(APP_INTERCEPTOR, { useExisting: StudioTimingInterceptor }),
    ],
  });
}

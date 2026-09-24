/** Optional, application-owned structured log capture. No console patching or ambient state. */
import { APP_INTERCEPTOR, defineModule, defineProvider } from '@velajs/vela';
import { APP_LOGGER } from '@velajs/vela/logging';
import { describeToken, getExecutionLifetime } from '@velajs/vela/module-kit';
import type {
  CallHandler,
  ExecutionContext,
  ModuleImport,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
} from '@velajs/vela';
import type { ApplicationLogger, LogRecord } from '@velajs/vela/logging';
import { parseStudioInvocationDiagnostic } from '@velajs/studio-protocol';
import type { AdminLogEntry, StudioInvocationDiagnostic } from '@velajs/studio-protocol';
import { AdminLogBuffer } from '../logs/log-buffer';

export interface StudioLoggingModuleOptions {
  /** Include the configured StudioModule and LoggingModule instances. */
  imports?: ModuleImport[];
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
        source: `${describeToken(context.getClass())}#${String(context.getHandler())}`,
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

const { ConfigurableModuleClass } = defineModule<StudioLoggingModuleOptions, 'imports'>({
  name: 'StudioLogging',
  structural: ['imports'],
  key: () => 'application',
  setup: ({ OPTIONS, options }) => ({
    imports: options.imports,
    providers: [
      defineProvider(StudioLogCapture, {
        inject: [APP_LOGGER, AdminLogBuffer],
        useFactory: (logger, buffer) => new StudioLogCapture(logger, buffer),
      }),
      defineProvider(StudioTimingInterceptor, {
        inject: [APP_LOGGER, OPTIONS],
        useFactory: (logger, settings) => new StudioTimingInterceptor(logger, settings.timings),
      }),
      defineProvider(APP_INTERCEPTOR, { useExisting: StudioTimingInterceptor }),
    ],
    exports: [StudioLogCapture, StudioTimingInterceptor],
  }),
});

/** Opt in to capturing the configured application's normalized, redacted structured records. */
export class StudioLoggingModule extends ConfigurableModuleClass {}

/** Correlation data only; never an authentication or tenant authority. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: string;
  readonly isRemote?: boolean;
}

export type TelemetryAttributes = Readonly<Record<string, string | number | boolean>>;
export type TelemetryOutcome = 'success' | 'error' | 'cancelled';
export type TelemetrySpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface TelemetrySpanOptions {
  readonly kind?: TelemetrySpanKind;
  readonly parent?: TraceContext;
  readonly attributes?: TelemetryAttributes;
}

export interface TelemetrySpan {
  readonly context: TraceContext | undefined;
  setAttributes(attributes: TelemetryAttributes): void;
  /** Idempotent for built-in adapters. Does not capture exception messages or stacks. */
  end(outcome?: TelemetryOutcome): void;
}

export interface TelemetryCounter {
  add(value: number, attributes?: TelemetryAttributes): void;
}

export interface TelemetryHistogram {
  record(value: number, attributes?: TelemetryAttributes): void;
}

export interface TelemetryMetricOptions {
  readonly unit?: string;
  readonly description?: string;
}

/** Synchronous recording only. The application owns SDK setup, flushing, and delivery. */
export interface Telemetry {
  startSpan(name: string, options?: TelemetrySpanOptions): TelemetrySpan;
  createCounter(name: string, options?: TelemetryMetricOptions): TelemetryCounter;
  createHistogram(name: string, options?: TelemetryMetricOptions): TelemetryHistogram;
}

/** Explicit invocation-local handle, safe to pass to independently usable integrations. */
export interface ScopedTelemetry {
  readonly telemetry: Telemetry;
  readonly span: TelemetrySpan;
}

/**
 * The engine's exception family. Extends Vela's `HttpException` so a thrown
 * engine error renders natively through `HandlerExecutor` and is catchable by
 * any `APP_FILTER` — no sub-app onError rethrow hack.
 *
 * `getResponse()` returns the canonical error envelope
 * `{ success: false, error: { code, message, details? } }` (hono-crud 0.13
 * parity, byte-compatible for the default envelope). A configured custom
 * `ResponseEnvelope.error` is applied by the engine's response boundary,
 * which reads `structured` off the exception instead.
 */

import { HttpException } from '@velajs/vela';

/** Known error codes (open union — custom codes pass through untouched). */
export type CrudErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'AGGREGATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'TENANT_REQUIRED'
  | 'INTERNAL_ERROR'
  | (string & {});

/**
 * Structured error passed to `ResponseEnvelope.error`. Open shape so custom
 * envelopes can enrich it (RFC 7807, JSON:API, house standards).
 */
export interface StructuredError {
  code: CrudErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
  [key: string]: unknown;
}

/** One flattened Zod issue inside VALIDATION_ERROR details. */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export class CrudException extends HttpException {
  public readonly code: CrudErrorCode;
  public readonly details?: unknown;

  constructor(message: string, status = 500, code: CrudErrorCode = 'INTERNAL_ERROR', details?: unknown) {
    const error: StructuredError = { code, message };
    if (details !== undefined) error.details = details;
    super({ success: false, error: error as unknown as Record<string, unknown> } as Record<string, unknown>, status);
    this.name = 'CrudException';
    this.code = code;
    this.details = details;
    // HttpException JSON-stringifies object responses into `message`; restore
    // the human-readable one.
    this.message = message;
  }

  /** The structured error a custom `ResponseEnvelope.error` receives. */
  get structured(): StructuredError {
    const error: StructuredError = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

export class InputValidationException extends CrudException {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'InputValidationException';
  }

  /** Flattens a Zod (v4) error into the canonical issue list. */
  static fromZodError(error: { issues: Array<{ path: Array<PropertyKey>; message: string; code: string }> }): InputValidationException {
    const issues: ValidationIssue[] = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    return new InputValidationException('Validation failed', issues);
  }
}

export class NotFoundException extends CrudException {
  constructor(resource = 'Resource', id?: string) {
    super(id ? `${resource} with id '${id}' not found` : `${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundException';
  }
}

export class ConflictException extends CrudException {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
    this.name = 'ConflictException';
  }
}

export class UnauthorizedException extends CrudException {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends CrudException {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenException';
  }
}

export class AggregationException extends CrudException {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'AGGREGATION_ERROR', details);
    this.name = 'AggregationException';
  }
}

export class ConfigurationException extends CrudException {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'CONFIGURATION_ERROR', details);
    this.name = 'ConfigurationException';
  }
}

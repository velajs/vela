export type ExceptionResponse = string | Record<string, unknown>;

/** Optional data for an {@link HttpException}. */
export interface HttpExceptionOptions {
  /**
   * Client-safe structured data rendered as `error.details` beside a string
   * message on a 4xx (for example a validation issue list). 5xx details are
   * never sent. Object responses render verbatim and do not include it.
   */
  details?: unknown;
  /** The underlying error, kept server-side as the standard `Error.cause`. */
  cause?: unknown;
}

/**
 * The HTTP response an exception renders as, returned by its `toResponse()`
 * hook: a status from 400 to 599 and a JSON body.
 */
export interface HttpErrorResponse {
  readonly status: number;
  readonly body: unknown;
}

export class HttpException extends Error {
  public readonly statusCode: number;
  readonly #response: ExceptionResponse;
  readonly #details: unknown;

  constructor(response: ExceptionResponse, statusCode: number, options?: HttpExceptionOptions) {
    const message = typeof response === 'string' ? response : JSON.stringify(response);
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpException';
    this.statusCode = statusCode;
    this.#response = response;
    this.#details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): Record<string, unknown> {
    if (typeof this.#response === 'string') {
      return { statusCode: this.statusCode, message: this.#response };
    }
    return this.#response;
  }

  /** The `details` option, rendered as `error.details` on a 4xx string response. */
  getDetails(): unknown {
    return #details in this ? this.#details : undefined;
  }

  /**
   * The response this exception owns, used by every HTTP error edge before the
   * canonical `{ error: { code, message, details? } }` body. An object response
   * renders verbatim; a string response returns `undefined` and takes the
   * canonical body, which redacts 5xx text. Subclasses override it to own
   * their wire shape.
   */
  toResponse(): HttpErrorResponse | undefined {
    if (!(#response in this) || typeof this.#response === 'string') return undefined;
    return { status: this.statusCode, body: this.#response };
  }
}

// 4xx

export class BadRequestException extends HttpException {
  constructor(message: ExceptionResponse = 'Bad Request', options?: HttpExceptionOptions) {
    super(message, 400, options);
    this.name = 'BadRequestException';
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message: ExceptionResponse = 'Unauthorized', options?: HttpExceptionOptions) {
    super(message, 401, options);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends HttpException {
  constructor(message: ExceptionResponse = 'Forbidden', options?: HttpExceptionOptions) {
    super(message, 403, options);
    this.name = 'ForbiddenException';
  }
}

export class NotFoundException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Found', options?: HttpExceptionOptions) {
    super(message, 404, options);
    this.name = 'NotFoundException';
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(message: ExceptionResponse = 'Method Not Allowed', options?: HttpExceptionOptions) {
    super(message, 405, options);
    this.name = 'MethodNotAllowedException';
  }
}

export class NotAcceptableException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Acceptable', options?: HttpExceptionOptions) {
    super(message, 406, options);
    this.name = 'NotAcceptableException';
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(message: ExceptionResponse = 'Request Timeout', options?: HttpExceptionOptions) {
    super(message, 408, options);
    this.name = 'RequestTimeoutException';
  }
}

export class ConflictException extends HttpException {
  constructor(message: ExceptionResponse = 'Conflict', options?: HttpExceptionOptions) {
    super(message, 409, options);
    this.name = 'ConflictException';
  }
}

export class GoneException extends HttpException {
  constructor(message: ExceptionResponse = 'Gone', options?: HttpExceptionOptions) {
    super(message, 410, options);
    this.name = 'GoneException';
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message: ExceptionResponse = 'Payload Too Large', options?: HttpExceptionOptions) {
    super(message, 413, options);
    this.name = 'PayloadTooLargeException';
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(
    message: ExceptionResponse = 'Unsupported Media Type',
    options?: HttpExceptionOptions,
  ) {
    super(message, 415, options);
    this.name = 'UnsupportedMediaTypeException';
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message: ExceptionResponse = 'Unprocessable Entity', options?: HttpExceptionOptions) {
    super(message, 422, options);
    this.name = 'UnprocessableEntityException';
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(message: ExceptionResponse = 'Too Many Requests', options?: HttpExceptionOptions) {
    super(message, 429, options);
    this.name = 'TooManyRequestsException';
  }
}

// 5xx

export class InternalServerErrorException extends HttpException {
  constructor(
    message: ExceptionResponse = 'Internal Server Error',
    options?: HttpExceptionOptions,
  ) {
    super(message, 500, options);
    this.name = 'InternalServerErrorException';
  }
}

export class NotImplementedException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Implemented', options?: HttpExceptionOptions) {
    super(message, 501, options);
    this.name = 'NotImplementedException';
  }
}

export class BadGatewayException extends HttpException {
  constructor(message: ExceptionResponse = 'Bad Gateway', options?: HttpExceptionOptions) {
    super(message, 502, options);
    this.name = 'BadGatewayException';
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message: ExceptionResponse = 'Service Unavailable', options?: HttpExceptionOptions) {
    super(message, 503, options);
    this.name = 'ServiceUnavailableException';
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(message: ExceptionResponse = 'Gateway Timeout', options?: HttpExceptionOptions) {
    super(message, 504, options);
    this.name = 'GatewayTimeoutException';
  }
}

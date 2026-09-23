export type ExceptionResponse = string | Record<string, unknown>;

/** Optional structured data for an {@link HttpException}. */
export interface HttpExceptionOptions {
  /**
   * Client-safe structured data sent as `error.details` alongside a string
   * message (for example, a validation issue list). Object responses are sent
   * verbatim and do not include it.
   */
  details?: unknown;
}

export class HttpException extends Error {
  public readonly statusCode: number;
  private readonly _response: ExceptionResponse;
  readonly #details: unknown;

  constructor(response: ExceptionResponse, statusCode: number, options?: HttpExceptionOptions) {
    const message = typeof response === 'string' ? response : JSON.stringify(response);
    super(message);
    this.name = 'HttpException';
    this.statusCode = statusCode;
    this._response = response;
    this.#details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): Record<string, unknown> {
    if (typeof this._response === 'string') {
      const details = this.getDetails();
      return {
        statusCode: this.statusCode,
        message: this._response,
        ...(details === undefined ? {} : { details }),
      };
    }
    return this._response;
  }

  // The constructor's original argument, untransformed — a string message or a
  // caller-supplied object. The HTTP error renderer branches on this: string
  // responses become `{ error: { code, message, details? } }`, object responses
  // ship verbatim (crud envelope compat). Distinct from `getResponse()`, which
  // wraps strings in the `{ statusCode, message, details? }` shape.
  getRawResponse(): ExceptionResponse {
    return this._response;
  }

  /** The `details` option, rendered as `error.details` for string messages. */
  getDetails(): unknown {
    // Error rendering must not throw for objects that only share the prototype.
    return #details in this ? this.#details : undefined;
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

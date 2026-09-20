export type ExceptionResponse = string | Record<string, unknown>;

export class HttpException extends Error {
  public readonly statusCode: number;
  private readonly _response: ExceptionResponse;

  constructor(response: ExceptionResponse, statusCode: number) {
    const message = typeof response === 'string' ? response : JSON.stringify(response);
    super(message);
    this.name = 'HttpException';
    this.statusCode = statusCode;
    this._response = response;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): Record<string, unknown> {
    if (typeof this._response === 'string') {
      return { statusCode: this.statusCode, message: this._response };
    }
    return this._response;
  }

  // The constructor's original argument, untransformed — a string message or a
  // caller-supplied object. The canonical HTTP edge branches on this: string
  // responses become `{ error: { code, message } }`, object responses ship
  // verbatim (crud envelope compat). Distinct from `getResponse()`, which wraps
  // strings in the legacy `{ statusCode, message }` shape.
  getRawResponse(): ExceptionResponse {
    return this._response;
  }
}

// 4xx

export class BadRequestException extends HttpException {
  constructor(message: ExceptionResponse = 'Bad Request') {
    super(message, 400);
    this.name = 'BadRequestException';
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message: ExceptionResponse = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends HttpException {
  constructor(message: ExceptionResponse = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenException';
  }
}

export class NotFoundException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Found') {
    super(message, 404);
    this.name = 'NotFoundException';
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(message: ExceptionResponse = 'Method Not Allowed') {
    super(message, 405);
    this.name = 'MethodNotAllowedException';
  }
}

export class NotAcceptableException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Acceptable') {
    super(message, 406);
    this.name = 'NotAcceptableException';
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(message: ExceptionResponse = 'Request Timeout') {
    super(message, 408);
    this.name = 'RequestTimeoutException';
  }
}

export class ConflictException extends HttpException {
  constructor(message: ExceptionResponse = 'Conflict') {
    super(message, 409);
    this.name = 'ConflictException';
  }
}

export class GoneException extends HttpException {
  constructor(message: ExceptionResponse = 'Gone') {
    super(message, 410);
    this.name = 'GoneException';
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message: ExceptionResponse = 'Payload Too Large') {
    super(message, 413);
    this.name = 'PayloadTooLargeException';
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(message: ExceptionResponse = 'Unsupported Media Type') {
    super(message, 415);
    this.name = 'UnsupportedMediaTypeException';
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message: ExceptionResponse = 'Unprocessable Entity') {
    super(message, 422);
    this.name = 'UnprocessableEntityException';
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(message: ExceptionResponse = 'Too Many Requests') {
    super(message, 429);
    this.name = 'TooManyRequestsException';
  }
}

// 5xx

export class InternalServerErrorException extends HttpException {
  constructor(message: ExceptionResponse = 'Internal Server Error') {
    super(message, 500);
    this.name = 'InternalServerErrorException';
  }
}

export class NotImplementedException extends HttpException {
  constructor(message: ExceptionResponse = 'Not Implemented') {
    super(message, 501);
    this.name = 'NotImplementedException';
  }
}

export class BadGatewayException extends HttpException {
  constructor(message: ExceptionResponse = 'Bad Gateway') {
    super(message, 502);
    this.name = 'BadGatewayException';
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message: ExceptionResponse = 'Service Unavailable') {
    super(message, 503);
    this.name = 'ServiceUnavailableException';
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(message: ExceptionResponse = 'Gateway Timeout') {
    super(message, 504);
    this.name = 'GatewayTimeoutException';
  }
}

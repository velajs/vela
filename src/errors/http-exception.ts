export class HttpException extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'HttpException';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): unknown {
    return (
      this.response ?? {
        statusCode: this.statusCode,
        message: this.message,
      }
    );
  }
}

// 4xx

export class BadRequestException extends HttpException {
  constructor(message = 'Bad Request', response?: unknown) {
    super(message, 400, response);
    this.name = 'BadRequestException';
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = 'Unauthorized', response?: unknown) {
    super(message, 401, response);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden', response?: unknown) {
    super(message, 403, response);
    this.name = 'ForbiddenException';
  }
}

export class NotFoundException extends HttpException {
  constructor(message = 'Not Found', response?: unknown) {
    super(message, 404, response);
    this.name = 'NotFoundException';
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(message = 'Method Not Allowed', response?: unknown) {
    super(message, 405, response);
    this.name = 'MethodNotAllowedException';
  }
}

export class NotAcceptableException extends HttpException {
  constructor(message = 'Not Acceptable', response?: unknown) {
    super(message, 406, response);
    this.name = 'NotAcceptableException';
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(message = 'Request Timeout', response?: unknown) {
    super(message, 408, response);
    this.name = 'RequestTimeoutException';
  }
}

export class ConflictException extends HttpException {
  constructor(message = 'Conflict', response?: unknown) {
    super(message, 409, response);
    this.name = 'ConflictException';
  }
}

export class GoneException extends HttpException {
  constructor(message = 'Gone', response?: unknown) {
    super(message, 410, response);
    this.name = 'GoneException';
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message = 'Payload Too Large', response?: unknown) {
    super(message, 413, response);
    this.name = 'PayloadTooLargeException';
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(message = 'Unsupported Media Type', response?: unknown) {
    super(message, 415, response);
    this.name = 'UnsupportedMediaTypeException';
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message = 'Unprocessable Entity', response?: unknown) {
    super(message, 422, response);
    this.name = 'UnprocessableEntityException';
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(message = 'Too Many Requests', response?: unknown) {
    super(message, 429, response);
    this.name = 'TooManyRequestsException';
  }
}

// 5xx

export class InternalServerErrorException extends HttpException {
  constructor(message = 'Internal Server Error', response?: unknown) {
    super(message, 500, response);
    this.name = 'InternalServerErrorException';
  }
}

export class NotImplementedException extends HttpException {
  constructor(message = 'Not Implemented', response?: unknown) {
    super(message, 501, response);
    this.name = 'NotImplementedException';
  }
}

export class BadGatewayException extends HttpException {
  constructor(message = 'Bad Gateway', response?: unknown) {
    super(message, 502, response);
    this.name = 'BadGatewayException';
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message = 'Service Unavailable', response?: unknown) {
    super(message, 503, response);
    this.name = 'ServiceUnavailableException';
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(message = 'Gateway Timeout', response?: unknown) {
    super(message, 504, response);
    this.name = 'GatewayTimeoutException';
  }
}

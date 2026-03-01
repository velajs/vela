export class HttpException extends Error {
  public readonly statusCode: number;
  private readonly _response: string | object;

  constructor(response: string | object, statusCode: number) {
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

  getResponse(): unknown {
    if (typeof this._response === 'object' && this._response !== null) {
      return this._response;
    }
    return { statusCode: this.statusCode, message: this._response };
  }
}

// 4xx

export class BadRequestException extends HttpException {
  constructor(message: string | object = 'Bad Request') {
    super(message, 400);
    this.name = 'BadRequestException';
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message: string | object = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends HttpException {
  constructor(message: string | object = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenException';
  }
}

export class NotFoundException extends HttpException {
  constructor(message: string | object = 'Not Found') {
    super(message, 404);
    this.name = 'NotFoundException';
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(message: string | object = 'Method Not Allowed') {
    super(message, 405);
    this.name = 'MethodNotAllowedException';
  }
}

export class NotAcceptableException extends HttpException {
  constructor(message: string | object = 'Not Acceptable') {
    super(message, 406);
    this.name = 'NotAcceptableException';
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(message: string | object = 'Request Timeout') {
    super(message, 408);
    this.name = 'RequestTimeoutException';
  }
}

export class ConflictException extends HttpException {
  constructor(message: string | object = 'Conflict') {
    super(message, 409);
    this.name = 'ConflictException';
  }
}

export class GoneException extends HttpException {
  constructor(message: string | object = 'Gone') {
    super(message, 410);
    this.name = 'GoneException';
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message: string | object = 'Payload Too Large') {
    super(message, 413);
    this.name = 'PayloadTooLargeException';
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(message: string | object = 'Unsupported Media Type') {
    super(message, 415);
    this.name = 'UnsupportedMediaTypeException';
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message: string | object = 'Unprocessable Entity') {
    super(message, 422);
    this.name = 'UnprocessableEntityException';
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(message: string | object = 'Too Many Requests') {
    super(message, 429);
    this.name = 'TooManyRequestsException';
  }
}

// 5xx

export class InternalServerErrorException extends HttpException {
  constructor(message: string | object = 'Internal Server Error') {
    super(message, 500);
    this.name = 'InternalServerErrorException';
  }
}

export class NotImplementedException extends HttpException {
  constructor(message: string | object = 'Not Implemented') {
    super(message, 501);
    this.name = 'NotImplementedException';
  }
}

export class BadGatewayException extends HttpException {
  constructor(message: string | object = 'Bad Gateway') {
    super(message, 502);
    this.name = 'BadGatewayException';
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message: string | object = 'Service Unavailable') {
    super(message, 503);
    this.name = 'ServiceUnavailableException';
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(message: string | object = 'Gateway Timeout') {
    super(message, 504);
    this.name = 'GatewayTimeoutException';
  }
}

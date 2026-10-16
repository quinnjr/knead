import { KneadError } from '@knead/core';

export const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** RFC 9457 problem details. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

export interface HttpExceptionOptions {
  type?: string;
  title?: string;
  extensions?: Record<string, unknown>;
  cause?: unknown;
  headers?: Bun.HeadersInit;
}

export class HttpException extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  readonly type: string;
  readonly title: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly headers: Headers;

  constructor(status: number, detail?: string, options: HttpExceptionOptions = {}) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(
        `HttpException status must be an integer between 400 and 599, got ${status}`,
      );
    }
    const title = options.title ?? STATUS_TITLES[status] ?? 'Error';
    super(detail ?? title, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.detail = detail;
    this.type = options.type ?? 'about:blank';
    this.title = title;
    this.extensions = options.extensions ?? {};
    this.headers = new Headers(options.headers);
  }

  toProblem(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      ...this.extensions,
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.detail !== undefined) problem.detail = this.detail;
    if (instance !== undefined) problem.instance = instance;
    return problem;
  }
}

export class BadRequestException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(400, detail, options);
  }
}
export class UnauthorizedException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(401, detail, options);
  }
}
export class ForbiddenException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(403, detail, options);
  }
}
export class NotFoundException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(404, detail, options);
  }
}
export class MethodNotAllowedException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(405, detail, options);
  }
}
export class ConflictException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(409, detail, options);
  }
}
export class UnsupportedMediaTypeException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(415, detail, options);
  }
}
export class UnprocessableEntityException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(422, detail, options);
  }
}
export class TooManyRequestsException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(429, detail, options);
  }
}
export class InternalServerErrorException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(500, detail, options);
  }
}
export class ServiceUnavailableException extends HttpException {
  constructor(detail?: string, options?: HttpExceptionOptions) {
    super(503, detail, options);
  }
}

/** Configuration errors detected while compiling or starting the application. */
export class HttpConfigError extends KneadError {}

export function problemResponse(problem: ProblemDetails, headers?: Bun.HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/problem+json; charset=utf-8');
  h.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(problem), { status: problem.status, headers: h });
}

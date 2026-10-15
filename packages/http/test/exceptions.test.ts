import { describe, expect, test } from 'bun:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  MethodNotAllowedException,
  NotFoundException,
  problemResponse,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '../src/index.js';

describe('HttpException', () => {
  test('defaults title from the status and type to about:blank', () => {
    const e = new HttpException(404);
    expect(e.status).toBe(404);
    expect(e.title).toBe('Not Found');
    expect(e.type).toBe('about:blank');
    expect(e.detail).toBeUndefined();
    expect(e.message).toBe('Not Found');
    expect(e.name).toBe('HttpException');
  });

  test('toProblem includes detail, instance and extensions; extensions cannot override reserved keys', () => {
    const e = new HttpException(409, 'Email taken', {
      type: 'https://errors.example/conflict',
      extensions: { field: 'email', status: 999 },
    });
    expect(e.toProblem('/users')).toEqual({
      type: 'https://errors.example/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Email taken',
      instance: '/users',
      field: 'email',
    });
  });

  test('carries headers and cause', () => {
    const cause = new Error('root');
    const e = new TooManyRequestsException('slow down', { headers: { 'retry-after': '3' }, cause });
    expect(e.headers.get('retry-after')).toBe('3');
    expect(e.cause).toBe(cause);
  });

  test.each([
    [BadRequestException, 400, 'Bad Request'],
    [UnauthorizedException, 401, 'Unauthorized'],
    [ForbiddenException, 403, 'Forbidden'],
    [NotFoundException, 404, 'Not Found'],
    [MethodNotAllowedException, 405, 'Method Not Allowed'],
    [ConflictException, 409, 'Conflict'],
    [UnsupportedMediaTypeException, 415, 'Unsupported Media Type'],
    [UnprocessableEntityException, 422, 'Unprocessable Content'],
    [TooManyRequestsException, 429, 'Too Many Requests'],
    [InternalServerErrorException, 500, 'Internal Server Error'],
    [ServiceUnavailableException, 503, 'Service Unavailable'],
  ] as const)('%p has status %p', (Cls, status, title) => {
    const e = new Cls('detail');
    expect(e).toBeInstanceOf(HttpException);
    expect(e.status).toBe(status);
    expect(e.title).toBe(title);
    expect(e.name).toBe(Cls.name);
  });
});

describe('problemResponse', () => {
  test('serializes RFC 9457 problem+json', async () => {
    const res = problemResponse(new NotFoundException('nope').toProblem('/x'), { 'x-extra': '1' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-extra')).toBe('1');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'nope',
      instance: '/x',
    });
  });
});

describe('HttpException status validation', () => {
  test.each([400, 599])('accepts boundary status %p', (status) => {
    expect(new HttpException(status).status).toBe(status);
  });

  test.each([200, 399, 600, 404.5, Number.NaN])('rejects status %p', (status) => {
    expect(() => new HttpException(status)).toThrow(RangeError);
    expect(() => new HttpException(status)).toThrow(
      `HttpException status must be an integer between 400 and 599, got ${status}`,
    );
  });
});

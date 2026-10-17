import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import {
  APP_FILTER,
  BadRequestException,
  Controller,
  type ExceptionFilter,
  Get,
  ServiceUnavailableException,
} from '@knead-js/http';
import { Test, type TestingModule } from '@knead-js/testing';
import { type PrismaErrorMapper, PrismaHttpModule, toHttpException } from '../src/http/index.js';

function prismaError(name: string, code?: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('SELECT * FROM "User" postgres://u:secret@h'), {
    name,
    ...(code === undefined ? {} : { code }),
    ...extra,
  });
}

const known = (code: string, meta?: Record<string, unknown>) =>
  prismaError('PrismaClientKnownRequestError', code, meta ? { meta } : {});

let thrown: unknown;

@Controller('/t')
class ThrowController {
  @Get('/') boom() {
    throw thrown;
  }
}

class CatchAll implements ExceptionFilter {
  catch() {
    return new Response('teapot', { status: 418 });
  }
}

@Module({ providers: [{ provide: APP_FILTER, multi: true, useClass: CatchAll }] })
class CatchAllModule {}

let mod: TestingModule | undefined;
afterEach(async () => {
  await mod?.close();
  mod = undefined;
});

async function hit(
  error: unknown,
  opts: {
    development?: boolean;
    map?: Record<string, PrismaErrorMapper>;
    after?: boolean;
  } = {},
) {
  thrown = error;
  mod = await Test.createModule({
    imports: [
      PrismaHttpModule.forRoot(opts.map ? { map: opts.map } : {}),
      ...(opts.after ? [CatchAllModule] : []),
    ],
    controllers: [ThrowController],
  }).compile({ development: opts.development ?? false });
  const app = await mod.createApp();
  const res = await app.request('GET', '/t');
  const text = await res.text();
  return { res, text, body: text.startsWith('{') ? JSON.parse(text) : undefined };
}

describe('PrismaHttpModule', () => {
  test('maps by name and code, not instanceof', async () => {
    const { res, body } = await hit(known('P2002'));
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(body.detail).toBe('A record with these values already exists.');
  });

  const rows: [string, Error, number, string | undefined][] = [
    ['P2003', known('P2003'), 409, 'The operation conflicts with a related record.'],
    ['P2025', known('P2025'), 404, 'The requested record was not found.'],
    ['P2000', known('P2000'), 400, 'A value is too long for its field.'],
    [
      'validation',
      prismaError('PrismaClientValidationError'),
      400,
      'The request could not be processed.',
    ],
    ['P1001', prismaError('PrismaClientKnownRequestError', 'P1001'), 503, undefined],
    ['P1002', prismaError('PrismaClientKnownRequestError', 'P1002'), 503, undefined],
    ['P2024', prismaError('PrismaClientKnownRequestError', 'P2024'), 503, undefined],
    ['initialization', prismaError('PrismaClientInitializationError'), 503, undefined],
    ['unknown', prismaError('PrismaClientUnknownRequestError'), 500, undefined],
    ['rust panic', prismaError('PrismaClientRustPanicError'), 500, undefined],
  ];
  for (const [label, error, status, detail] of rows) {
    test(`maps ${label} to ${status}`, async () => {
      const { res, body } = await hit(error, { development: false });
      expect(res.status).toBe(status);
      if (status < 500) expect(body.detail).toBe(detail);
      else expect(body.detail).toBeUndefined();
    });
  }

  test('503 in development carries the fixed detail', async () => {
    const { res, body } = await hit(prismaError('PrismaClientInitializationError'), {
      development: true,
    });
    expect(res.status).toBe(503);
    expect(body.detail).toBe('The database is temporarily unavailable.');
  });

  test('never copies message', async () => {
    const cases: [Error, boolean][] = [
      [known('P2002'), false],
      [known('P1001'), false],
      [prismaError('PrismaClientUnknownRequestError'), false],
      [known('P2002'), true],
      [known('P2025'), true],
    ];
    for (const [error, development] of cases) {
      const { res, text, body } = await hit(error, { development });
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('secret');
      if (res.status >= 500 && !development) {
        expect(body.detail).toBeUndefined();
        expect(typeof body.correlationId).toBe('string');
      }
      await mod?.close();
      mod = undefined;
    }
  });

  test('dev fields are names only', async () => {
    const dev = await hit(known('P2002', { target: ['email'] }), { development: true });
    expect(dev.body.fields).toEqual(['email']);
    expect(dev.body.prismaCode).toBe('P2002');
    await mod?.close();
    const odd = await hit(known('P2002', { target: { email: 'a@b.c' } }), { development: true });
    expect(odd.body.fields).toBeUndefined();
    expect(odd.text).not.toContain('a@b.c');
    await mod?.close();
    const prod = await hit(known('P2002', { target: ['email'] }), { development: false });
    expect(prod.body.fields).toBeUndefined();
    expect(prod.body.prismaCode).toBeUndefined();
  });

  test('dev fields come from a Prisma 7 driver adapter error', async () => {
    const adapterMeta = (fields: unknown) => ({
      modelName: 'User',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "User_email_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields },
        },
      },
    });
    const dev = await hit(known('P2002', adapterMeta(['email'])), { development: true });
    expect(dev.body.fields).toEqual(['email']);
    expect(dev.text).not.toContain('duplicate key');
    await mod?.close();
    const odd = await hit(known('P2002', adapterMeta([{ email: 'a@b.c' }])), {
      development: true,
    });
    expect(odd.body.fields).toBeUndefined();
    expect(odd.text).not.toContain('a@b.c');
    await mod?.close();
    // `meta.target` is still read when the adapter shape is absent or unusable.
    const fallback = await hit(known('P2002', { ...adapterMeta('email'), target: ['handle'] }), {
      development: true,
    });
    expect(fallback.body.fields).toEqual(['handle']);
  });

  test('declines non-Prisma errors to later filters', async () => {
    const { res, text } = await hit(new Error('x'), { after: true });
    expect(res.status).toBe(418);
    expect(text).toBe('teapot');
    expect(mod?.logs.some((l) => String(l.message).includes('did not return a Response'))).toBe(
      false,
    );
  });

  test('declines non-Error values', async () => {
    const { res } = await hit('x');
    expect(res.status).toBe(500);
  });

  test('map overrides and extends', async () => {
    const over = await hit(known('P2002'), {
      map: { P2002: () => new BadRequestException('dup') },
    });
    expect(over.res.status).toBe(400);
    expect(over.body.detail).toBe('dup');
    await mod?.close();
    const ext = await hit(known('P2034'), {
      map: { P2034: () => new ServiceUnavailableException() },
    });
    expect(ext.res.status).toBe(503);
  });

  test('a mapper that throws is treated as unmapped', async () => {
    const { res, body } = await hit(known('P2002'), {
      map: {
        P2002: () => {
          throw new Error('mapper bug');
        },
      },
    });
    expect(res.status).toBe(500);
    expect(body.detail).toBeUndefined();
    expect(typeof body.correlationId).toBe('string');
  });

  test('a mapper that returns a non-HttpException is treated as unmapped', async () => {
    const { res, body } = await hit(known('P2002'), {
      map: { P2002: (() => undefined) as unknown as PrismaErrorMapper },
    });
    expect(res.status).toBe(500);
    expect(body.detail).toBeUndefined();
    expect(typeof body.correlationId).toBe('string');
  });

  test('maps a plain object from another realm by name and code', async () => {
    const { res } = await hit({ name: 'PrismaClientKnownRequestError', code: 'P2002' });
    expect(res.status).toBe(409);
  });

  test('declines an unknown PrismaClient*Error name', async () => {
    const { res } = await hit(prismaError('PrismaClientFooError', 'P2002'), { after: true });
    expect(res.status).toBe(418);
  });
});

describe('toHttpException', () => {
  test('returns undefined for non-Prisma errors', () => {
    expect(toHttpException(new Error('x'))).toBeUndefined();
    expect(toHttpException('x')).toBeUndefined();
    expect(toHttpException(null)).toBeUndefined();
    expect(toHttpException({ name: 'PrismaClientFooError' })).toBeUndefined();
  });
});

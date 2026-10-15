import { describe, expect, test } from 'bun:test';
import { getMetadata, getMethodMetadata, getOwnMetadata } from '@hpmws/core';
import {
  All,
  CATCH,
  Catch,
  CONTROLLER,
  Controller,
  createRouteDecorator,
  FILTERS,
  Get,
  GUARDS,
  MIDDLEWARE,
  MODULE_MIDDLEWARE,
  ModuleMiddleware,
  Post,
  ROUTE_META,
  ROUTES,
  UseFilters,
  UseGuards,
  UseMiddleware,
} from '../src/index.js';

const allow = () => true;
const passthrough = (_ctx: unknown, next: () => Promise<Response>) => next();

describe('@Controller and route decorators', () => {
  test('store prefix, options and routes in declaration order', () => {
    @Controller('/users', { guards: [allow] })
    class UsersController {
      @Get('/:id') find() {}
      @Post('/', { status: 201 }) create() {}
      @All('/any') any() {}
    }
    expect(getOwnMetadata(UsersController, CONTROLLER)).toEqual({
      prefix: '/users',
      options: { guards: [allow] },
    });
    expect(getMetadata(UsersController, ROUTES)).toEqual([
      { methods: ['GET'], path: '/:id', handler: 'find', options: {} },
      { methods: ['POST'], path: '/', handler: 'create', options: { status: 201 } },
      {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        path: '/any',
        handler: 'any',
        options: {},
      },
    ]);
  });

  test('subclass routes do not leak into the parent (Review Focus 3)', () => {
    @Controller('/base')
    class Base {
      @Get('/ping') ping() {}
    }
    @Controller('/child')
    class Child extends Base {
      @Get('/extra') extra() {}
    }
    expect(getMetadata(Base, ROUTES)!.map((r) => r.handler)).toEqual(['ping']);
    expect(getMetadata(Child, ROUTES)!.map((r) => r.handler)).toEqual(['ping', 'extra']);
    expect(getOwnMetadata(Child, CONTROLLER)!.prefix).toBe('/child');
  });

  test('static methods cannot be routes', () => {
    expect(() => {
      class Bad {
        @Get('/') static nope() {}
      }
      return Bad;
    }).toThrow(TypeError);
  });
});

describe('@UseGuards / @UseMiddleware / @UseFilters', () => {
  test('work at class and method level', () => {
    class AFilter {
      catch() {
        return new Response();
      }
    }
    @UseGuards(allow)
    @UseMiddleware(passthrough)
    @UseFilters(AFilter)
    class C {
      @UseGuards(allow, allow)
      @UseMiddleware(passthrough)
      @UseFilters(AFilter)
      m() {}
    }
    expect(getMetadata(C, GUARDS)).toEqual([allow]);
    expect(getMetadata(C, MIDDLEWARE)).toEqual([passthrough]);
    expect(getMetadata(C, FILTERS)).toEqual([AFilter]);
    expect(getMethodMetadata(C, 'm', GUARDS)).toEqual([allow, allow]);
    expect(getMethodMetadata(C, 'm', MIDDLEWARE)).toEqual([passthrough]);
    expect(getMethodMetadata(C, 'm', FILTERS)).toEqual([AFilter]);
  });
});

describe('@Catch and @ModuleMiddleware', () => {
  test('store their arguments', () => {
    @Catch(TypeError, RangeError)
    class F {}
    @ModuleMiddleware(passthrough)
    class M {}
    expect(getMetadata(F, CATCH)).toEqual([TypeError, RangeError]);
    expect(getMetadata(M, MODULE_MIDDLEWARE)).toEqual([passthrough]);
  });
});

describe('createRouteDecorator', () => {
  const Roles = createRouteDecorator<string[]>('roles');
  const Public = createRouteDecorator<boolean>('public');

  test('merges class and method metadata without touching other classes', () => {
    @Roles(['user'])
    class C {
      @Roles(['admin'])
      @Public(true)
      m() {}
      n() {}
    }
    @Roles(['other'])
    class D {}
    expect(getMetadata(C, ROUTE_META)).toEqual({ roles: ['user'] });
    expect(getMethodMetadata(C, 'm', ROUTE_META)).toEqual({ roles: ['admin'], public: true });
    expect(getMethodMetadata(C, 'n', ROUTE_META)).toBeUndefined();
    expect(getMetadata(D, ROUTE_META)).toEqual({ roles: ['other'] });
  });
});

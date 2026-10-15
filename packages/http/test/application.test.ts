import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inject, Module, type OnModuleDestroy, type OnModuleInit } from '@hpmws/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  APP_GUARD,
  APP_MIDDLEWARE,
  Catch,
  Controller,
  type Ctx,
  createRouteDecorator,
  Delete,
  type ExceptionFilter,
  Get,
  type Guard,
  HpmwsFactory,
  type HttpApplication,
  HttpConfigError,
  MemoryLogger,
  type Middleware,
  ModuleMiddleware,
  type Next,
  NotFoundException,
  Post,
  UseFilters,
  UseMiddleware,
  WsRegistry,
} from '../src/index.js';
import { start } from './helpers.js';

const CreateUser: StandardSchemaV1<unknown, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      const name = (value as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' && name.length > 0
        ? { value: { name } }
        : { issues: [{ message: 'name is required', path: ['name'] }] };
    },
  },
};

const tag =
  (name: string) =>
  async (_ctx: Ctx, next: () => Promise<Response>): Promise<Response> => {
    const res = await next();
    res.headers.append('x-chain', name);
    return res;
  };

const Roles = createRouteDecorator<string[]>('roles');

class RolesGuard implements Guard {
  canActivate(ctx: Ctx) {
    const roles = ctx.route?.meta.roles as string[] | undefined;
    return !roles || roles.includes(ctx.req.headers.get('x-role') ?? '');
  }
}

class UsersService {
  readonly users = new Map([['1', { id: '1', name: 'Ada' }]]);
  find(id: string) {
    return this.users.get(id);
  }
  create(name: string) {
    const user = { id: String(this.users.size + 1), name };
    this.users.set(user.id, user);
    return user;
  }
}

class Teapot extends Error {}
@Catch(Teapot)
class TeapotFilter implements ExceptionFilter<Teapot> {
  catch() {
    return new Response('teapot', { status: 418 });
  }
}

@Controller('/users', { middleware: [tag('controller')] })
class UsersController {
  readonly users = inject(UsersService);

  @Get('/') list() {
    return [...this.users.users.values()];
  }
  @Get('/boom') boom() {
    throw new Error('kaboom');
  }
  @Get('/teapot') @UseFilters(TeapotFilter) teapot() {
    throw new Teapot();
  }
  @Get('/whoami') whoami(ctx: Ctx) {
    return { ip: ctx.ip, secure: ctx.secure };
  }
  @Get('/:id') find({ params }: Ctx<{ params: { id: string } }>) {
    const user = this.users.find(params.id);
    if (!user) throw new NotFoundException(`User ${params.id} not found`);
    return user;
  }
  @Get('/:id/avatar') avatar() {
    return new Blob(['png'], { type: 'image/png' });
  }
  @Post('/', { body: CreateUser, status: 201, guards: [RolesGuard] })
  @Roles(['admin'])
  create({ body }: Ctx<{ body: { name: string } }>) {
    return this.users.create(body.name);
  }
  @Delete('/:id') remove(ctx: Ctx<{ params: { id: string } }>) {
    ctx.res.headers.set('x-deleted', ctx.params.id);
  }
}

@Controller('/chat')
class ChatController {
  @Get('/') page() {
    return 'chat page';
  }
}

class ChatGateway implements OnModuleInit {
  readonly ws = inject(WsRegistry);
  onModuleInit() {
    this.ws.register('/chat', {
      upgrade: (ctx) => (ctx.query.token === 'ok' ? { user: 'ada' } : false),
      message: (socket, message) =>
        void socket.send(`${(socket.data.data as { user: string }).user}:${message}`),
    });
  }
}

@ModuleMiddleware(tag('module'))
@Module({ controllers: [UsersController], providers: [UsersService] })
class UsersModule {}

@Module({
  imports: [UsersModule],
  controllers: [ChatController],
  providers: [
    ChatGateway,
    { provide: APP_MIDDLEWARE, multi: true, useValue: { middleware: tag('global'), priority: 10 } },
  ],
})
class AppModule {}

let app: HttpApplication;
const url = (path: string) => new URL(path, app.url);
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
});

beforeAll(async () => {
  app = await start(AppModule);
});
afterAll(async () => {
  await app.close();
});

describe('routing and response mapping', () => {
  test('JSON responses run global → module → controller middleware', async () => {
    const res = await fetch(url('/users'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-chain')).toBe('controller, module, global');
    expect(await res.json()).toEqual([{ id: '1', name: 'Ada' }]);
  });

  test('params are decoded; thrown HttpExceptions become problem+json', async () => {
    const res = await fetch(url('/users/a%20b'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'User a b not found',
      instance: '/users/a%20b',
    });
  });

  test('undefined return is 204 with draft headers', async () => {
    const res = await fetch(url('/users/1'), { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-deleted')).toBe('1');
  });

  test('Blob responses keep their type; HEAD is served by GET', async () => {
    expect((await fetch(url('/users/1/avatar'))).headers.get('content-type')).toBe('image/png');
    const head = await fetch(url('/users/1'), { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  test('unknown errors are masked 500s; route filters handle their errors', async () => {
    const boom = await fetch(url('/users/boom'));
    expect(boom.status).toBe(500);
    expect(((await boom.json()) as { detail?: string }).detail).toBeUndefined();
    expect((await fetch(url('/users/teapot'))).status).toBe(418);
  });

  test('ctx.ip and ctx.secure', async () => {
    expect(await (await fetch(url('/users/whoami'))).json()).toEqual({
      ip: '127.0.0.1',
      secure: false,
    });
  });
});

describe('guards, validation and bodies', () => {
  test('route guards read route metadata', async () => {
    const res = await fetch(url('/users'), json({ name: 'Grace' }));
    expect(res.status).toBe(403);
  });

  test('valid bodies are created with the route status', async () => {
    const res = await fetch(url('/users'), json({ name: 'Grace' }, { 'x-role': 'admin' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe('Grace');
  });

  test('invalid bodies are 400 with issues', async () => {
    const res = await fetch(url('/users'), json({}, { 'x-role': 'admin' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: unknown }).issues).toEqual([
      { source: 'body', message: 'name is required', path: ['name'] },
    ]);
  });

  test('malformed JSON is 400 and unsupported media is 415 (Review Focus 1)', async () => {
    const malformed = await fetch(url('/users'), {
      method: 'POST',
      body: '{nope',
      headers: { 'content-type': 'application/json', 'x-role': 'admin' },
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { detail: string }).detail).toBe('Malformed JSON body');
    const xml = await fetch(url('/users'), {
      method: 'POST',
      body: '<a/>',
      headers: { 'content-type': 'application/xml', 'x-role': 'admin' },
    });
    expect(xml.status).toBe(415);
  });
});

describe('fallback', () => {
  test('unknown paths are 404 and still run global middleware', async () => {
    const res = await fetch(url('/nope'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-chain')).toBe('global');
  });

  test('known paths with the wrong method are 405 with Allow', async () => {
    const res = await fetch(url('/users/1'), { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, DELETE, HEAD');
  });

  test('trailing slashes are strict', async () => {
    expect((await fetch(url('/users/1/'))).status).toBe(404);
  });

  test('the route table lists every route', () => {
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toContain('POST /users');
  });
});

describe('websocket endpoints', () => {
  const wsUrl = (path: string) => url(path).toString().replace('http', 'ws');

  test('a GET route and a WebSocket endpoint can share a path', async () => {
    expect(await (await fetch(url('/chat'))).text()).toBe('chat page');
    const socket = new WebSocket(wsUrl('/chat?token=ok'));
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send('hi');
      socket.onmessage = (e) => resolve(String(e.data));
      socket.onerror = () => reject(new Error('socket error'));
    });
    expect(reply).toBe('ada:hi');
    socket.close();
  });

  test('a rejected upgrade is answered with 403', async () => {
    const statusLine = await new Promise<string>((resolve, reject) => {
      let buf = '';
      Bun.connect({
        hostname: '127.0.0.1',
        port: Number(app.url.port),
        socket: {
          open(sock) {
            sock.write(
              [
                'GET /chat?token=bad HTTP/1.1',
                `Host: 127.0.0.1:${app.url.port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version: 13',
                '',
                '',
              ].join('\r\n'),
            );
          },
          data(sock, chunk) {
            buf += chunk.toString();
            if (buf.includes('\r\n')) {
              resolve(buf.split('\r\n')[0] ?? '');
              sock.end();
            }
          },
          error(_s, e) {
            reject(e);
          },
        },
      }).catch(reject);
    });
    expect(statusLine).toContain('403');
  });

  test('a rejected upgrade never opens', async () => {
    const socket = new WebSocket(wsUrl('/chat?token=bad'));
    const opened = await new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
    });
    expect(opened).toBe(false);
  });
});

describe('global registration', () => {
  test('imperative global middleware, guards and filters', async () => {
    @Controller('/x')
    class X {
      @Get('/') x() {
        throw new Teapot();
      }
      @Get('/ok') ok() {
        return 'ok';
      }
    }
    @Module({ controllers: [X] })
    class M {}
    const app2 = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    app2
      .useGlobalMiddleware(tag('imperative'), 5)
      .useGlobalGuards((ctx: Ctx) => ctx.req.headers.get('x-block') !== '1')
      .useGlobalFilters(new TeapotFilter());
    await app2.listen({ port: 0, hostname: '127.0.0.1' });
    const base = app2.url;
    expect((await fetch(new URL('/x', base))).status).toBe(418);
    const blocked = await fetch(new URL('/x/ok', base), { headers: { 'x-block': '1' } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('x-chain')).toBe('imperative');
    expect(() => app2.useGlobalMiddleware(tag('late'))).toThrow(HttpConfigError);
    await app2.close();
  });

  test('APP_GUARD providers apply to every route', async () => {
    class DenyAll implements Guard {
      canActivate() {
        return false;
      }
    }
    @Controller('/y')
    class Y {
      @Get('/') y() {
        return 'y';
      }
    }
    @Module({
      controllers: [Y],
      providers: [{ provide: APP_GUARD, multi: true, useValue: DenyAll }],
    })
    class M {}
    const app3 = await start(M);
    expect((await fetch(new URL('/y', app3.url))).status).toBe(403);
    await app3.close();
  });
});

describe('global middleware ordering', () => {
  test('higher priority first; ties by registration order, providers before imperative', async () => {
    @Controller('/o')
    class O {
      @Get('/') o() {
        return 'o';
      }
    }
    @Module({
      controllers: [O],
      providers: [
        {
          provide: APP_MIDDLEWARE,
          multi: true,
          useValue: { middleware: tag('provider10'), priority: 10 },
        },
      ],
    })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    a.useGlobalMiddleware(tag('imperative5'), 5).useGlobalMiddleware(tag('imperative10'), 10);
    await a.listen({ port: 0, hostname: '127.0.0.1' });
    const res = await fetch(new URL('/o', a.url));
    // appended on the way out: innermost first, so the reverse of run order
    expect(res.headers.get('x-chain')).toBe('imperative5, imperative10, provider10');
    await a.close();
  });
});

describe('listen atomicity and global provider scope', () => {
  test('a failed listen leaves no partial state', async () => {
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    class Gw implements OnModuleInit {
      readonly ws = inject(WsRegistry);
      onModuleInit() {}
    }
    @Module({ providers: [Gw] })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    await expect(a.listen({ port: blocker.port, hostname: '127.0.0.1' })).rejects.toThrow();
    expect(a.routes).toEqual([]);
    a.get(WsRegistry).register('/after', { upgrade: () => ({}) });
    await a.listen({ port: 0, hostname: '127.0.0.1' });
    await a.close();
    blocker.stop(true);
  });

  test('close() after a failed listen runs shutdown hooks and resolves', async () => {
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const log: string[] = [];
    class Resource implements OnModuleDestroy {
      onModuleDestroy() {
        log.push('destroy');
      }
    }
    @Module({ providers: [Resource] })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    await expect(a.listen({ port: blocker.port, hostname: '127.0.0.1' })).rejects.toThrow();
    expect(log).toEqual([]);
    await expect(a.close()).resolves.toBeUndefined();
    expect(log).toEqual(['destroy']);
    blocker.stop(true);
  });

  test('class refs from APP_GUARD in a feature module resolve with that module injector', async () => {
    class Secret {
      readonly value = 's3';
    }
    class SecretGuard implements Guard {
      readonly secret = inject(Secret);
      canActivate(ctx: Ctx) {
        return ctx.req.headers.get('x-secret') === this.secret.value;
      }
    }
    @Module({ providers: [Secret, { provide: APP_GUARD, multi: true, useValue: SecretGuard }] })
    class Feature {}
    @Controller('/g')
    class G {
      @Get('/') g() {
        return 'g';
      }
    }
    @Module({ imports: [Feature], controllers: [G] })
    class M {}
    const a = await start(M);
    expect((await fetch(new URL('/g', a.url))).status).toBe(403);
    expect((await fetch(new URL('/g', a.url), { headers: { 'x-secret': 's3' } })).status).toBe(200);
    await a.close();
  });
});

describe('bootstrap errors', () => {
  test('duplicate routes', async () => {
    @Controller('/d')
    class A {
      @Get('/') a() {}
    }
    @Controller('/d')
    class B {
      @Get('/') b() {}
    }
    @Module({ controllers: [A, B] })
    class M {}
    await expect(start(M)).rejects.toThrow('Duplicate route GET /d: A.a and B.b.');
  });

  test('routes that differ only by parameter name', async () => {
    @Controller('/p')
    class A {
      @Get('/:id') a() {}
      @Delete('/:userId') b() {}
    }
    @Module({ controllers: [A] })
    class M {}
    await expect(start(M)).rejects.toThrow(/differ only in parameter names/);
  });

  test('controllers without @Controller', async () => {
    class Bare {}
    @Module({ controllers: [Bare] })
    class M {}
    await expect(start(M)).rejects.toThrow(
      'Bare is listed in M.controllers but is not decorated with @Controller().',
    );
  });

  test('listen twice', async () => {
    @Module({})
    class M {}
    const a = await start(M);
    await expect(a.listen({ port: 0 })).rejects.toThrow(HttpConfigError);
    await a.close();
  });
});

describe('lifecycle of lazily constructed classes', () => {
  test('a @UseMiddleware class gets onModuleInit at listen and onModuleDestroy at close', async () => {
    const log: string[] = [];
    class Tracked implements Middleware, OnModuleInit, OnModuleDestroy {
      onModuleInit() {
        log.push('init');
      }
      onModuleDestroy() {
        log.push('destroy');
      }
      use(_ctx: Ctx, next: Next) {
        return next();
      }
    }
    @Controller('/t')
    @UseMiddleware(Tracked)
    class C {
      @Get('/') get() {
        return 'ok';
      }
    }
    @Module({ controllers: [C] })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    expect(log).toEqual([]);
    await a.listen({ port: 0, hostname: '127.0.0.1' });
    expect(log).toEqual(['init']);
    expect(await (await fetch(new URL('/t', a.url))).text()).toBe('ok');
    await a.close();
    expect(log).toEqual(['init', 'destroy']);
  });

  test('a failing late onModuleInit rejects listen without binding a server', async () => {
    class Broken implements Guard<Ctx>, OnModuleInit {
      onModuleInit() {
        throw new Error('guard init failed');
      }
      canActivate() {
        return true;
      }
    }
    @Controller('/b')
    class C {
      @Get('/', { guards: [Broken] }) get() {
        return 'ok';
      }
    }
    @Module({ controllers: [C] })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    await expect(a.listen({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow('guard init failed');
    expect(() => a.server).toThrow(HttpConfigError);
  });
});

describe('listen after or during close', () => {
  test('a retried listen after a failed late onModuleInit rejects: the application is closed', async () => {
    class Broken implements Guard<Ctx>, OnModuleInit {
      onModuleInit() {
        throw new Error('guard init failed');
      }
      canActivate() {
        return true;
      }
    }
    @Controller('/r')
    class C {
      @Get('/', { guards: [Broken] }) get() {
        return 'ok';
      }
    }
    @Module({ controllers: [C] })
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    await expect(a.listen({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow('guard init failed');
    await expect(a.listen({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow(
      new HttpConfigError('The application is closed.'),
    );
    expect(() => a.server).toThrow(HttpConfigError);
    await a.close();
  });

  test('listen after a completed close rejects', async () => {
    @Module({})
    class M {}
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    await a.close();
    await expect(a.listen({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow(
      new HttpConfigError('The application is closed.'),
    );
    expect(() => a.server).toThrow(HttpConfigError);
  });

  test('close() during the late init await aborts listen without binding', async () => {
    class SlowGuard implements Guard<Ctx>, OnModuleInit {
      async onModuleInit() {
        await Bun.sleep(50);
      }
      canActivate() {
        return true;
      }
    }
    @Controller('/s')
    class C {
      @Get('/', { guards: [SlowGuard] }) get() {
        return 'ok';
      }
    }
    @Module({ controllers: [C] })
    class M {}
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('x') });
    const port = probe.port as number;
    probe.stop(true);
    const a = await HpmwsFactory.create(M, { logger: new MemoryLogger() });
    const listening = a.listen({ port, hostname: '127.0.0.1' });
    await Bun.sleep(5);
    const closing = a.close();
    await expect(listening).rejects.toThrow(
      new HttpConfigError('The application was closed during listen().'),
    );
    await expect(closing).resolves.toBeUndefined();
    expect(() => a.server).toThrow(HttpConfigError);
    await expect(fetch(`http://127.0.0.1:${port}/s`)).rejects.toThrow();
  });
});

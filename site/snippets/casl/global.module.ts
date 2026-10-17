import {
  AbilityGuard,
  Can,
  CaslModule,
  canMeta,
  SkipAbility,
  skipAbilityMeta,
} from '@knead-js/casl';
import { inject, Module, type OnModuleInit } from '@knead-js/core';
import { APP_GUARD, Controller, Get, type WsEndpoint, WsRegistry } from '@knead-js/http';
import { permissions } from './permissions.js';
import { defineUserAbility, sessionFrom, type User } from './users.js';

// #region controller
@Controller('/')
export class StatusController {
  @Get('/health')
  @SkipAbility()
  health() {
    return { ok: true };
  }

  @Get('/me')
  @Can('read', 'User')
  me() {
    return { ok: true };
  }

  @Get('/internal')
  internal() {
    // Neither @Can() nor @SkipAbility(): denied by the global AbilityGuard.
    return { ok: true };
  }
}
// #endregion controller

// #region gateway
export class FeedGateway implements OnModuleInit {
  readonly #ws = inject(WsRegistry);

  onModuleInit() {
    const feed: WsEndpoint = {
      upgrade: () => ({}),
      open(socket) {
        socket.send('welcome');
      },
    };
    // The meta forms of @Can() and @SkipAbility(), for endpoints without a decorator.
    this.#ws.register('/feed', feed, { meta: canMeta('read', 'Post') });
    this.#ws.register('/status', feed, { meta: skipAbilityMeta() });
    // Registered without either: every upgrade is denied with 403.
    this.#ws.register('/admin-feed', feed);
  }
}
// #endregion gateway

// #region module
@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Global guards run before controller and route guards: resolve() authenticates by itself.
      resolve: (ctx) => ('req' in ctx ? sessionFrom(ctx.req) : undefined),
      defineUserAbility,
    }),
  ],
  controllers: [StatusController],
  providers: [FeedGateway, { provide: APP_GUARD, multi: true, useExisting: AbilityGuard }],
})
export class AppModule {}
// #endregion module

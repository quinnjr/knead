// #region quick-start
import {
  AbilityGuard,
  AbilityService,
  asSubject,
  Can,
  CaslModule,
  definePermissions,
  type Identity,
} from '@knead-js/casl';
import { inject, Module } from '@knead-js/core';
import { Controller, type Ctx, Get, NotFoundException, Put, UseGuards } from '@knead-js/http';

interface User {
  id: string;
  admin: boolean;
}

/** What a credential can be granted: one area, three cumulative levels. */
export const permissions = definePermissions({
  posts: {
    description: 'Blog posts',
    levels: ['none', 'read', 'write'],
    rules: {
      read: [{ action: 'read', subject: 'Post' }],
      write: [{ action: ['create', 'update'], subject: 'Post' }],
    },
  },
});

/** Your token store: each bearer token maps to its user and the grant it was issued with. */
export const tokens = new Map<string, Identity<User>>();

export const posts = new Map([['1', { id: '1', authorId: 'alice', title: 'Hello' }]]);

@Controller('/posts')
@UseGuards(AbilityGuard)
export class PostsController {
  readonly #abilities = inject(AbilityService);

  @Get('/')
  @Can('read', 'Post')
  list() {
    return [...posts.values()];
  }

  @Put('/:id')
  @Can('update', 'Post')
  async update(ctx: Ctx<{ params: { id: string } }>) {
    const post = posts.get(ctx.params.id);
    if (!post) throw new NotFoundException();
    // @Can() checked the subject type; this checks { authorId: user.id } against the record.
    await this.#abilities.authorize(ctx, 'update', asSubject('Post', post));
    return post;
  }
}

@Module({
  imports: [
    CaslModule.forRoot<User>({
      permissions,
      // Who is calling, with which grant; undefined (or null) means unauthenticated (401).
      resolve: (ctx) => {
        const header = 'req' in ctx ? ctx.req.headers.get('authorization') : null;
        return header?.startsWith('Bearer ') ? tokens.get(header.slice(7)) : undefined;
      },
      // The most this user may ever do; the grant narrows it.
      defineUserAbility(user, { can }) {
        can('read', 'Post');
        can(['create', 'update'], 'Post', { authorId: user.id });
        if (user.admin) can('manage', 'all');
      },
    }),
  ],
  controllers: [PostsController],
})
export class AppModule {}
// #endregion quick-start

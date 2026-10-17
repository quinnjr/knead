import {
  AbilityGuard,
  AbilityService,
  asSubject,
  Can,
  ForbiddenError,
  SkipAbility,
} from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Get, NotFoundException, Post, Put, UseGuards } from '@knead-js/http';

export interface BlogPost {
  id: string;
  authorId: string;
  title: string;
  published: boolean;
}

export const posts = new Map<string, BlogPost>([
  ['1', { id: '1', authorId: 'alice', title: 'Hello', published: false }],
]);

// #region controller
@Controller('/posts')
@UseGuards(AbilityGuard)
export class PostsController {
  readonly #abilities = inject(AbilityService);

  @Get('/')
  @Can('read', 'Post')
  list() {
    return [...posts.values()];
  }

  @Get('/count')
  @SkipAbility()
  count() {
    return { count: posts.size };
  }

  // #region authorize
  @Put('/:id')
  @Can('update', 'Post')
  async update(ctx: Ctx<{ params: { id: string } }>) {
    const post = posts.get(ctx.params.id);
    if (!post) throw new NotFoundException();
    // @Can() checked the subject type; this checks { authorId: user.id } against the record.
    await this.#abilities.authorize(ctx, 'update', asSubject('Post', post));
    return post;
  }
  // #endregion authorize

  // #region forbidden-error
  @Post('/:id/publish')
  @Can('update', 'Post')
  async publish(ctx: Ctx<{ params: { id: string } }>) {
    const post = posts.get(ctx.params.id);
    if (!post) throw new NotFoundException();
    const ability = await this.#abilities.forCtx(ctx);
    // CaslForbiddenFilter turns this into a 403 problem; CASL's message is not sent.
    ForbiddenError.from(ability).throwUnlessCan('update', asSubject('Post', post));
    post.published = true;
    return post;
  }
  // #endregion forbidden-error

  @Get('/drafts')
  drafts() {
    // No @Can() and no @SkipAbility(): AbilityGuard denies this route.
    return [...posts.values()].filter((p) => !p.published);
  }
}
// #endregion controller

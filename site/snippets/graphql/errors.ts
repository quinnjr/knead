import { Module } from '@knead-js/core';
import { GraphQLModule, ID, Mutation, Query, Resolver, type ResolverCtx } from '@knead-js/graphql';
import { BadRequestException, ForbiddenException, NotFoundException } from '@knead-js/http';

// #region domain-error
/** A domain error from the service layer, unknown to Knead. */
export class PostLockedError extends Error {
  constructor(readonly postId: string) {
    super(`Post ${postId} is locked`);
    this.name = 'PostLockedError';
  }
}
// #endregion domain-error

// #region resolver
@Resolver()
export class EditorResolver {
  @Query(() => String, { args: { id: ID } })
  draft(ctx: ResolverCtx<{ id: string }>): string {
    // NOT_FOUND, with this message, even in production.
    throw new NotFoundException(`No draft ${ctx.args.id}`);
  }

  @Mutation(() => Boolean, { args: { id: ID } })
  rename(ctx: ResolverCtx<{ id: string }>): boolean {
    // BAD_USER_INPUT; extensions are sent next to the code.
    throw new BadRequestException(`The new title of ${ctx.args.id} is taken.`, {
      extensions: { field: 'title' },
    });
  }

  @Mutation(() => Boolean, { args: { id: ID } })
  edit(ctx: ResolverCtx<{ id: string }>): boolean {
    throw new PostLockedError(ctx.args.id);
  }

  @Query(() => String)
  report(): string {
    // Unexpected: INTERNAL_SERVER_ERROR, masked outside development, logged with a correlation id.
    throw new Error('connect ECONNREFUSED postgres://reporting:hunter2@10.0.0.7:5432');
  }
}
// #endregion resolver

// #region map-error
@Module({
  imports: [
    GraphQLModule.forRoot({
      mapError: (error) =>
        error instanceof PostLockedError ? new ForbiddenException(error.message) : undefined,
    }),
  ],
  providers: [EditorResolver],
})
export class ErrorsAppModule {}
// #endregion map-error

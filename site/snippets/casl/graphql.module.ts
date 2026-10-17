import {
  type AbilityCtx,
  AbilityGuard,
  AbilitySubject,
  Can,
  CaslModule,
  type Identity,
  mapCaslError,
  SkipAbility,
} from '@knead-js/casl';
import { Module } from '@knead-js/core';
import {
  Field,
  GraphQLModule,
  Int,
  ObjectType,
  Query,
  Resolver,
  Subscription,
} from '@knead-js/graphql';
import { permissions } from './permissions.js';
import { userRecords } from './users.controller.js';
import { defineUserAbility, sessionFrom, type User } from './users.js';

// #region context
declare module '@knead-js/graphql' {
  interface GraphQLContext {
    /** The caller, from the bearer token; read by CaslModule's resolve(). */
    identity?: Identity<User>;
  }
}
// #endregion context

// #region type
@ObjectType()
@AbilitySubject('User')
export class UserType {
  @Field(() => String) id!: string;
  @Field(() => String, { nullable: true }) name?: string | null;
  @Field(() => String, { nullable: true }) email?: string | null;
  @Field(() => String, { nullable: true }) billingAddress?: string | null;
}
// #endregion type

// #region resolver
@Resolver()
export class UsersResolver {
  @Query(() => [UserType])
  @Can('read', 'User')
  users() {
    return userRecords;
  }

  @Query(() => UserType, { nullable: true })
  @SkipAbility()
  featuredUser() {
    // Open to anyone, but each UserType field still needs an identity and `read` on it.
    return userRecords[1];
  }

  // #region subscription
  @Subscription(() => Int, { topic: 'post-count', recheckGuards: true })
  @Can('read', 'Post')
  postCount() {}
  // #endregion subscription
}
// #endregion resolver

// #region resolve
/** REST requests carry the token; GraphQL resolvers read the identity the context put there. */
function identityOf(ctx: AbilityCtx): Identity<User> | undefined {
  if ('req' in ctx) return sessionFrom(ctx.req);
  return 'identity' in ctx ? (ctx.identity as Identity<User> | undefined) : undefined;
}
// #endregion resolve

// #region module
@Module({
  imports: [
    GraphQLModule.forRoot({
      // Fields of this object are on every resolver ctx.
      context: (http) => ({ identity: sessionFrom(http.req) }),
      // Every query, mutation and subscription root field needs @Can() or @SkipAbility().
      guards: [AbilityGuard],
      // A CASL ForbiddenError thrown by a resolver is FORBIDDEN, not a masked internal error.
      mapError: mapCaslError,
      subscriptions: {
        // Before each recheck: look the token up again, so a revoked one ends the subscription.
        refreshContext: ({ http }) => {
          const identity = sessionFrom(http.req);
          return identity ? { identity } : false;
        },
      },
    }),
    CaslModule.forRoot<User>({ permissions, defineUserAbility, resolve: identityOf }),
  ],
  providers: [UsersResolver],
})
export class AppModule {}
// #endregion module

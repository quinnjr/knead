import { inject, Module } from '@knead-js/core';
import {
  Field,
  GraphQLModule,
  ID,
  Int,
  Mutation,
  ObjectType,
  Public,
  Query,
  Resolver,
  type ResolverCtx,
  UseFieldGuards,
} from '@knead-js/graphql';
import { createRouteDecorator, type Guard, UseGuards } from '@knead-js/http';
import * as v from 'valibot';
import { SessionModule, SessionService } from './sessions.js';

// #region guards
/** Passes when a member is signed in. A guard passes only on `true`. */
export const SignedIn = (ctx: ResolverCtx) => ctx.member !== undefined;

const ROLES = Symbol('roles');
/** Route metadata: shows up in `ctx.meta[ROLES]`. */
export const Roles = createRouteDecorator<readonly string[]>(ROLES);

export class RolesGuard implements Guard<ResolverCtx> {
  canActivate(ctx: ResolverCtx): boolean {
    const required = ctx.meta[ROLES] as readonly string[] | undefined;
    if (!required) return true;
    return required.some((role) => ctx.member?.roles.includes(role) === true);
  }
}
// #endregion guards

// #region account
/** Field guards run before every field of the type, wherever it appears in a response. */
const OwnAccountOnly = (ctx: ResolverCtx<{}, Account>) => ctx.parent.id === ctx.member?.id;

@ObjectType()
@UseFieldGuards(OwnAccountOnly)
export class Account {
  @Field(() => ID) id!: string;
  // Denied fields become null with a FORBIDDEN error, so make them nullable.
  @Field(() => String, { nullable: true }) name?: string | null;
}
// #endregion account

// #region resolver
const Amount = v.pipe(v.number(), v.integer(), v.minValue(1));

/** Runs after validate, so it sees the validated arguments. */
const SmallTransfer = (ctx: ResolverCtx<{ amount: number }>) => ctx.args.amount <= 100;

@Resolver()
@UseGuards(RolesGuard)
export class AccountResolver {
  @Query(() => String)
  @Public()
  health(): string {
    return 'ok';
  }

  @Query(() => Account, { nullable: true })
  me(ctx: ResolverCtx): Account | undefined {
    return ctx.member && { id: ctx.member.id, name: ctx.member.name };
  }

  @Query(() => Account, { nullable: true, args: { id: ID } })
  account(ctx: ResolverCtx<{ id: string }>): Account {
    return { id: ctx.args.id, name: 'Someone else' };
  }

  @Mutation(() => Int, {
    args: { amount: Int },
    validate: { amount: Amount },
    authorize: [SmallTransfer],
  })
  @Roles(['admin'])
  transfer(ctx: ResolverCtx<{ amount: number }>): number {
    return ctx.args.amount;
  }
}
// #endregion resolver

// #region forgotten
/** No guard of its own and not @Public(): FORBIDDEN under defaultDeny. */
@Resolver()
export class StatsResolver {
  @Query(() => Int)
  postCount(): number {
    return 3;
  }
}
// #endregion forgotten

// #region module
@Module({
  imports: [
    GraphQLModule.forRootAsync({
      imports: [SessionModule],
      useFactory: () => {
        const sessions = inject(SessionService);
        return {
          context: (http) => ({
            member: sessions.fromAuthorization(http.req.headers.get('authorization')),
          }),
          // Every root field runs SignedIn first, unless it is @Public().
          guards: [SignedIn],
          // A root field without a guard of its own (or @Public()) is FORBIDDEN.
          defaultDeny: true,
        };
      },
    }),
  ],
  providers: [AccountResolver, StatsResolver],
})
export class GuardedAppModule {}
// #endregion module

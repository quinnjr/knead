import { AbilitySubject, Can } from '@knead-js/casl';
import { Field, ID, ObjectType, Query, Resolver, type ResolverCtx } from '@knead-js/graphql';

/**
 * The signed-in account. `@AbilitySubject('Account')` makes every field require `read` on that
 * field of this record, so `roles` is null (with a FORBIDDEN error) for a token whose grant does
 * not cover it. Denied fields are nullable: a denied non-null field would null `me` instead.
 */
@ObjectType()
@AbilitySubject('Account')
export class Account {
  @Field(() => ID) id!: string;
  @Field(() => String, { nullable: true }) name?: string | null;
  @Field(() => [String], { nullable: true }) roles?: string[] | null;
}

@Resolver()
export class AccountResolver {
  @Query(() => Account)
  @Can('read', 'Account')
  me(ctx: ResolverCtx): Account {
    const { id, name, roles } = ctx.currentUser!;
    return { id, name, roles: [...roles] };
  }
}

import { inject } from '@knead/core';
import { Field, ID, Mutation, ObjectType, Query, Resolver, type ResolverCtx } from '@knead/graphql';
import { sanitize } from '@knead/sanitize';
import * as v from 'valibot';
import type { User } from '../auth/auth.js';
import { UsersService } from './users.service.js';

declare module '@knead/graphql' {
  interface GraphQLContext {
    user?: User;
  }
}

@ObjectType({ name: 'User' })
export class UserType {
  @Field(() => ID) id!: string;
  @Field(() => String) name!: string;
  @Field(() => String) bio!: string;
}

const AdminOnly = (ctx: ResolverCtx) => ctx.user?.roles.includes('admin') ?? false;

const Name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
const Bio = v.pipe(
  v.nullish(v.string(), ''),
  v.maxLength(2000),
  v.transform((html) => sanitize(html, 'basic')),
);

@Resolver(() => UserType)
export class UsersResolver {
  readonly #users = inject(UsersService);

  @Query(() => [UserType])
  users(): UserType[] {
    return this.#users.list();
  }

  @Query(() => UserType, { args: { id: ID } })
  user(ctx: ResolverCtx<{ id: string }>): UserType {
    return this.#users.get(ctx.args.id);
  }

  @Mutation(() => UserType, {
    args: { name: String, bio: { type: () => String, nullable: true } },
    validate: { name: Name, bio: Bio },
    guards: [AdminOnly],
  })
  createUser(ctx: ResolverCtx<{ name: string; bio?: string | null }>): UserType {
    return this.#users.create({ name: ctx.args.name, bio: ctx.args.bio ?? '' });
  }
}

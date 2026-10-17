import { Can, SkipAbility } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import {
  Field,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  type ResolverCtx,
} from '@knead-js/graphql';
import { sanitize } from '@knead-js/sanitize';
import * as v from 'valibot';
import type { Session } from '../auth/permissions.js';
import { UsersService } from './users.service.js';

declare module '@knead-js/graphql' {
  interface GraphQLContext {
    session?: Session;
  }
}

@ObjectType({ name: 'User' })
export class UserType {
  @Field(() => ID) id!: string;
  @Field(() => String) name!: string;
  @Field(() => String) bio!: string;
}

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
  @SkipAbility()
  users(): UserType[] {
    return this.#users.list();
  }

  @Query(() => UserType, { args: { id: ID } })
  @SkipAbility()
  user(ctx: ResolverCtx<{ id: string }>): UserType {
    return this.#users.get(ctx.args.id);
  }

  @Mutation(() => UserType, {
    args: { name: String, bio: { type: () => String, nullable: true } },
    validate: { name: Name, bio: Bio },
  })
  @Can('create', 'User')
  createUser(ctx: ResolverCtx<{ name: string; bio?: string | null }>): UserType {
    return this.#users.create({ name: ctx.args.name, bio: ctx.args.bio ?? '' });
  }
}

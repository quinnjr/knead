import {
  ArgsType,
  defineEnum,
  defineScalar,
  defineUnion,
  Field,
  Float,
  ID,
  InputType,
  Int,
  InterfaceType,
  ObjectType,
} from '@knead-js/graphql';
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

// #region scalar
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseDate(value: unknown): Date {
  const date = typeof value === 'string' && ISO_8601.test(value) ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    throw new GraphQLError('DateTime must be an ISO-8601 date-time string with a time zone.');
  }
  return date;
}

export const DateTime = defineScalar<Date>(
  new GraphQLScalarType<Date, string>({
    name: 'DateTime',
    description: 'An ISO-8601 date-time string, such as 2026-01-31T12:00:00.000Z.',
    serialize: (value) => (value instanceof Date ? value : parseDate(value)).toISOString(),
    parseValue: parseDate,
    parseLiteral: (ast) => {
      if (ast.kind !== Kind.STRING) throw new GraphQLError('DateTime must be a string.');
      return parseDate(ast.value);
    },
  }),
);
// #endregion scalar

// #region enum
export enum PostStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
}

export const PostStatusType = defineEnum(PostStatus, {
  name: 'PostStatus',
  description: 'Whether readers can see a post',
  valuesConfig: { DRAFT: { description: 'Visible to its author only' } },
});
// #endregion enum

// #region interface
@InterfaceType({ description: 'An object with a globally unique id' })
export class Node {
  @Field(() => ID) id!: string;
}
// #endregion interface

// #region object-types
@ObjectType({ implements: () => [Node] })
export class Author extends Node {
  @Field(() => String) name!: string;
  @Field(() => String, { nullable: true }) bio?: string | null;
}

@ObjectType({ implements: () => [Node], description: 'A blog post' })
export class Post extends Node {
  @Field(() => String) title!: string;
  @Field(() => PostStatusType) status!: PostStatus;
  @Field(() => [String]) tags!: string[];
  @Field(() => Int, { description: 'Number of words in the body' }) words!: number;
  @Field(() => Float, { nullable: true }) rating?: number | null;
  @Field(() => DateTime) createdAt!: Date;
  @Field(() => DateTime, { nullable: true }) publishedAt?: Date | null;
  /** Not a GraphQL field: `author` is resolved by PostResolver. */
  authorId!: string;
}
// #endregion object-types

// #region lists
@ObjectType()
export class Lists {
  @Field(() => [String]) required!: string[]; // [String!]!
  @Field(() => [String], { nullable: 'items' }) items!: (string | null | undefined)[]; // [String]!
  @Field(() => [String], { nullable: 'list' }) list?: string[] | null; // [String!]
  @Field(() => [String], { nullable: 'both' }) both?: (string | null | undefined)[] | null; // [String]
}
// #endregion lists

// #region union
export const SearchResult = defineUnion({
  name: 'SearchResult',
  description: 'A post or an author matching a search term',
  types: () => [Post, Author],
});
// #endregion union

// #region input
@InputType({ description: 'A new post' })
export class CreatePostInput {
  @Field(() => String) title!: string;
  @Field(() => [String], { nullable: true }) tags?: string[] | null;
  @Field(() => Boolean, { nullable: true, defaultValue: false }) publish?: boolean | null;
}
// #endregion input

// #region args
@ArgsType()
export class PageArgs {
  @Field(() => Int, { defaultValue: 10 }) first!: number;
  @Field(() => Int, { defaultValue: 0 }) offset!: number;
}

@ArgsType()
export class PostsArgs extends PageArgs {
  @Field(() => PostStatusType, { nullable: true }) status?: PostStatus | null;
}
// #endregion args

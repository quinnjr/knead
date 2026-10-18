// #region quick-start
import { Injectable, inject, Module } from '@knead-js/core';
import {
  type BatchLoader,
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverCtx,
} from '@knead-js/graphql';

@ObjectType()
export class Author {
  @Field(() => ID) id!: string;
  @Field(() => String) name!: string;
}

@ObjectType()
export class Book {
  @Field(() => ID) id!: string;
  @Field(() => String) title!: string;
  // A nullable field must accept both null and undefined, or it does not compile.
  @Field(() => String, { nullable: true }) subtitle?: string | null;
  /** Not a GraphQL field: `author` is resolved below. */
  authorId!: string;
}

@Injectable()
export class Library {
  readonly books: Book[] = [
    { id: 'b1', title: 'Kindred', authorId: 'a1' },
    { id: 'b2', title: 'Parable of the Sower', authorId: 'a1' },
  ];
  readonly authors = new Map([['a1', { id: 'a1', name: 'Octavia E. Butler' }]]);
}

/** Batches every `Book.author` of one operation into a single call. */
@Injectable()
export class AuthorsById implements BatchLoader<string, Author> {
  readonly #library = inject(Library);

  async batch(ids: readonly string[]): Promise<(Author | Error)[]> {
    return ids.map((id) => this.#library.authors.get(id) ?? new Error(`No author ${id}`));
  }
}

@Resolver(() => Book)
export class BookResolver {
  readonly #library = inject(Library);

  @Query(() => [Book])
  books(): Book[] {
    return this.#library.books;
  }

  @Query(() => Book, { nullable: true, args: { id: ID } })
  book(ctx: ResolverCtx<{ id: string }>): Book | undefined {
    return this.#library.books.find((book) => book.id === ctx.args.id);
  }

  @ResolveField(() => Author)
  author(ctx: ResolverCtx<{}, Book>): Promise<Author> {
    return ctx.loader(AuthorsById).load(ctx.parent.authorId);
  }
}

@Module({
  imports: [GraphQLModule.forRoot()],
  providers: [Library, AuthorsById, BookResolver],
})
export class AppModule {}
// #endregion quick-start

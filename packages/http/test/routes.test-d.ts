// Type-level tests: checked by `pnpm typecheck`, never executed.
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  Controller,
  type Ctx,
  createRouteDecorator,
  Get,
  type Guard,
  type PathParams,
  Post,
  UseGuards,
} from '../src/index.js';

declare function schema<T>(): StandardSchemaV1<unknown, T>;
const CreateUser = schema<{ name: string }>();
const Paging = schema<{ page: number }>();
const Roles = createRouteDecorator<string[]>('roles');

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertParams: Equal<
  PathParams<'/users/:id/posts/:postId'>,
  { id: string; postId: string }
> = true;
const assertNoParams: Equal<PathParams<'/health'>, {}> = true;
void assertParams;
void assertNoParams;

class AuthGuard implements Guard {
  canActivate() {
    return true;
  }
}

@Controller('/users')
@UseGuards(AuthGuard)
@Roles(['admin'])
export class UsersController {
  @Get('/') list() {
    return [];
  }
  @Get('/plain') plain(ctx: Ctx) {
    return ctx.params;
  }
  @Get('/:id') find({ params }: Ctx<{ params: { id: string } }>) {
    return params.id;
  }
  @Get('/:id/posts/:postId') post(ctx: Ctx<{ params: { id: string; postId: string } }>) {
    return ctx.params.postId;
  }
  @Get('/:id/loose') loose(ctx: Ctx) {
    return ctx.params;
  }
  @Post('/', { body: CreateUser, status: 201 })
  @UseGuards(AuthGuard)
  @Roles(['owner'])
  create({ body }: Ctx<{ body: { name: string } }>) {
    return body.name;
  }
  @Get('/paged', { query: Paging }) paged(ctx: Ctx<{ query: { page: number } }>) {
    return ctx.query.page;
  }
  @Get('/async') async asyncHandler() {
    return 1;
  }

  // @ts-expect-error postId is not in the path
  @Get('/:id') bad1(ctx: Ctx<{ params: { id: string; postId: string } }>) {
    return ctx;
  }
  // @ts-expect-error body type does not match the schema
  @Post('/', { body: CreateUser }) bad2(ctx: Ctx<{ body: { age: number } }>) {
    return ctx;
  }
  // @ts-expect-error query is a number, handler expects a string
  @Get('/q', { query: Paging }) bad3(ctx: Ctx<{ query: { page: string } }>) {
    return ctx;
  }
}

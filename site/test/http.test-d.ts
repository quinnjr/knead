// Type-level checks for the claims on the controllers, request-context and validation pages.
// Checked by `pnpm typecheck`, never executed.
import { Controller, type Ctx, Get, type PathParams, Post } from '@knead-js/http';
import * as v from 'valibot';
import { CreateBook } from '../snippets/http/validation.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const params: Equal<PathParams<'/users/:id'>, { id: string }> = true;
export const dotted: Equal<PathParams<'/files/:file.json'>, { 'file.json': string }> = true;

const Fields = v.object({ fields: v.picklist(['summary', 'full']) });

@Controller('/types')
export class TypesController {
  @Get('/:id') ok(ctx: Ctx<{ params: { id: string } }>) {
    return ctx.params.id;
  }

  // @ts-expect-error postId is not in the path
  @Get('/:id') extraParam(ctx: Ctx<{ params: { id: string; postId: string } }>) {
    return ctx;
  }

  // @ts-expect-error without a body schema, ctx.body is undefined
  @Post('/') noSchema(ctx: Ctx<{ body: { title: string } }>) {
    return ctx;
  }

  @Post('/', { body: CreateBook }) inferred(ctx: Ctx<{ body: v.InferOutput<typeof CreateBook> }>) {
    return ctx.body.title;
  }

  // @ts-expect-error title is a string in the schema output
  @Post('/', { body: CreateBook }) wrongBody(ctx: Ctx<{ body: { title: number } }>) {
    return ctx;
  }

  @Get('/q', { query: Fields }) wider(ctx: Ctx<{ query: { fields: string } }>) {
    return ctx.query.fields;
  }

  // @ts-expect-error fields is a string union, not a number
  @Get('/q', { query: Fields }) wrongQuery(ctx: Ctx<{ query: { fields: number } }>) {
    return ctx;
  }
}

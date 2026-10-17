import { Controller, type Ctx, Get, Post } from '@knead-js/http';
import * as v from 'valibot';

// #region schemas
const BookParams = v.object({
  id: v.pipe(v.string(), v.regex(/^\d+$/, 'id must be numeric'), v.transform(Number)),
});

const BookQuery = v.object({
  fields: v.optional(v.picklist(['summary', 'full'], 'fields must be summary or full'), 'summary'),
});

export const CreateBook = v.object({
  title: v.pipe(v.string('title must be a string'), v.trim(), v.minLength(1, 'title is empty')),
  year: v.pipe(v.number('year must be a number'), v.integer('year must be an integer')),
});
// #endregion schemas

// #region controller
@Controller('/books')
export class BooksController {
  @Get('/:id', { params: BookParams, query: BookQuery })
  find({ params, query }: Ctx<{ params: { id: number }; query: { fields: 'summary' | 'full' } }>) {
    return { id: params.id, fields: query.fields }; // params.id is a number here
  }

  @Post('/', { body: CreateBook, status: 201 })
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateBook> }>) {
    return { title: body.title, year: body.year };
  }
}
// #endregion controller

// #region headers
const ApiVersion = v.looseObject({
  'x-api-version': v.picklist(['1', '2']),
});

@Controller('/versioned')
export class VersionedController {
  @Get('/', { headers: ApiVersion })
  version({ headers }: Ctx<{ headers: v.InferOutput<typeof ApiVersion> }>) {
    return { version: headers['x-api-version'] };
  }
}
// #endregion headers

// #region authorize
const Invite = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email('email is invalid')),
});
type InviteInput = v.InferOutput<typeof Invite>;

// Runs after validation, so it sees the trimmed, lowercased address.
const companyOnly = (ctx: Ctx<{ body: InviteInput }>) => ctx.body.email.endsWith('@example.com');

@Controller('/invites')
export class InvitesController {
  @Post('/', { body: Invite, authorize: [companyOnly], status: 201 })
  invite({ body }: Ctx<{ body: InviteInput }>) {
    return { invited: body.email };
  }
}
// #endregion authorize

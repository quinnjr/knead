// Type-level tests: checked by `pnpm typecheck`, never executed.
import { Controller, Get, UseGuards } from '@knead-js/http';
import { type AbilityCtx, AbilityGuard, Can } from '../src/index.js';

@Controller()
@UseGuards(AbilityGuard)
export class PostsController {
  @Get('/posts') @Can('read', 'Post') list() {
    return [];
  }

  @Get('/posts/:id') @Can('read', 'Post', 'title') one() {
    return {};
  }

  // @ts-expect-error action and subject are required
  @Get('/x') @Can() x() {
    return {};
  }
}

// A structural GraphQL resolver context is an AbilityCtx without importing graphql.
const gqlCtx: AbilityCtx = {
  state: {},
  meta: {},
  info: {
    fieldName: 'posts',
    parentType: { name: 'Query' },
    schema: { getSubscriptionType: () => null },
  },
};
void gqlCtx;

import { AbilityGuard, Can } from '@knead-js/casl';
import { inject } from '@knead-js/core';
import { Controller, type Ctx, Delete, Get, Post, UseGuards } from '@knead-js/http';
import { sanitize } from '@knead-js/sanitize';
import * as v from 'valibot';
import { AuthGuard } from '../auth/auth.js';
import { UsersService } from './users.service.js';

const CreateUser = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  bio: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(2000),
      v.transform((html) => sanitize(html, 'basic')),
    ),
    '',
  ),
});

@Controller('/users')
export class UsersController {
  readonly #users = inject(UsersService);

  @Get('/') list() {
    return this.#users.list();
  }

  @Get('/:id') find({ params }: Ctx<{ params: { id: string } }>) {
    return this.#users.get(params.id);
  }

  @Post('/', { body: CreateUser, status: 201 })
  @UseGuards(AuthGuard, AbilityGuard)
  @Can('create', 'User')
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateUser> }>) {
    return this.#users.create(body);
  }

  @Delete('/:id')
  @UseGuards(AuthGuard, AbilityGuard)
  @Can('delete', 'User')
  remove({ params }: Ctx<{ params: { id: string } }>) {
    this.#users.remove(params.id);
  }
}

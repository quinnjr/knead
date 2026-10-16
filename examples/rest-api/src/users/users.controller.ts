import { inject } from '@knead/core';
import { Controller, type Ctx, Delete, Get, Post, UseGuards } from '@knead/http';
import { sanitize } from '@knead/sanitize';
import * as v from 'valibot';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth.js';
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
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(['admin'])
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateUser> }>) {
    return this.#users.create(body);
  }

  @Delete('/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(['admin'])
  remove({ params }: Ctx<{ params: { id: string } }>) {
    this.#users.remove(params.id);
  }
}

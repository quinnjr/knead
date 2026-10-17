import { inject } from '@knead-js/core';
import { Controller, type Ctx, Get, NotFoundException, Post } from '@knead-js/http';
import * as v from 'valibot';
import { UsersRepository } from './users.repository.js';
import { SignupService } from './users.service.js';

const UserId = v.object({ id: v.pipe(v.string(), v.digits(), v.transform(Number)) });

const CreateUser = v.object({
  email: v.pipe(v.string(), v.email()),
  name: v.nullable(v.pipe(v.string(), v.maxLength(100))),
  firstOrderTotal: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

// #region controller
@Controller('/users')
export class UsersController {
  readonly #users = inject(UsersRepository);
  readonly #signup = inject(SignupService);

  @Get('/:id', { params: UserId })
  async get({ params }: Ctx<{ params: v.InferOutput<typeof UserId> }>) {
    const user = await this.#users.findById(params.id);
    if (!user) throw new NotFoundException(`User ${params.id} does not exist`);
    return user;
  }

  // A second sign-up with the same email fails with P2002, answered as 409 Conflict.
  @Post('/', { body: CreateUser, status: 201 })
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateUser> }>) {
    return this.#signup.signUp(body);
  }
}
// #endregion controller

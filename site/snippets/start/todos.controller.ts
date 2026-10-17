import { inject } from '@knead-js/core';
import { Controller, type Ctx, Delete, Get, Post } from '@knead-js/http';
import * as v from 'valibot';
import { TodosService } from './todos.service.js';

// #region schemas
const TodoId = v.object({
  id: v.pipe(v.string(), v.digits(), v.transform(Number)),
});

const CreateTodo = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});
// #endregion schemas

@Controller('/todos')
export class TodosController {
  readonly #todos = inject(TodosService);

  @Get('/')
  list() {
    return this.#todos.list();
  }

  @Get('/:id', { params: TodoId })
  get({ params }: Ctx<{ params: v.InferOutput<typeof TodoId> }>) {
    return this.#todos.get(params.id);
  }

  @Post('/', { body: CreateTodo, status: 201 })
  create({ body }: Ctx<{ body: v.InferOutput<typeof CreateTodo> }>) {
    return this.#todos.create(body.title);
  }

  @Delete('/:id', { params: TodoId })
  remove({ params }: Ctx<{ params: v.InferOutput<typeof TodoId> }>) {
    this.#todos.remove(params.id);
  }
}

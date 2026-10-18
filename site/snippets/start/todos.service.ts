import { Injectable } from '@knead-js/core';
import { NotFoundException } from '@knead-js/http';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

@Injectable()
export class TodosService {
  readonly #todos = new Map<number, Todo>();
  #nextId = 1;

  list(): Todo[] {
    return [...this.#todos.values()];
  }

  get(id: number): Todo {
    const todo = this.#todos.get(id);
    if (!todo) throw new NotFoundException(`Todo ${id} does not exist`);
    return todo;
  }

  create(title: string): Todo {
    const todo = { id: this.#nextId++, title, done: false };
    this.#todos.set(todo.id, todo);
    return todo;
  }

  remove(id: number): void {
    this.get(id);
    this.#todos.delete(id);
  }
}

import { NotFoundException } from '@knead-js/http';

export interface UserRecord {
  id: string;
  name: string;
  bio: string;
}

export class UsersService {
  readonly #users = new Map<string, UserRecord>([['1', { id: '1', name: 'Ada', bio: '' }]]);
  #nextId = 2;

  list(): UserRecord[] {
    return [...this.#users.values()];
  }

  get(id: string): UserRecord {
    const user = this.#users.get(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  create(input: { name: string; bio: string }): UserRecord {
    const user = { id: String(this.#nextId++), ...input };
    this.#users.set(user.id, user);
    return user;
  }

  remove(id: string): void {
    this.get(id);
    this.#users.delete(id);
  }
}

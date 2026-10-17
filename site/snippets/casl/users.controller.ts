import { AbilityGuard, Can, PermittedFields } from '@knead-js/casl';
import { Controller, Get, UseGuards } from '@knead-js/http';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  billingAddress: string;
}

export const userRecords: UserRecord[] = [
  { id: 'alice', name: 'Alice', email: 'alice@example.com', billingAddress: '1 Main St' },
  { id: 'bob', name: 'Bob', email: 'bob@example.com', billingAddress: '2 Main St' },
];

// #region controller
@Controller('/users')
@UseGuards(AbilityGuard)
export class UsersController {
  @Get('/')
  @Can('read', 'User')
  @PermittedFields('User')
  list() {
    // Each record is stripped to the fields the caller may read on it.
    return userRecords;
  }

  @Get('/page')
  @Can('read', 'User')
  @PermittedFields('User')
  page() {
    // Wrong: an envelope is stripped as one record, so `data` (not a User field) is dropped.
    return { data: userRecords, total: userRecords.length };
  }
}
// #endregion controller

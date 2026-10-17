import { AbilityGuard, createCan } from '@knead-js/casl';
import { Controller, Get, UseGuards } from '@knead-js/http';

// #region typed
type AppActions = 'manage' | 'read' | 'create' | 'update' | 'delete';
type AppSubjects = 'all' | 'Post' | 'User';

export const Can = createCan<AppActions, AppSubjects>();
// #endregion typed

// #region usage
@Controller('/reports')
@UseGuards(AbilityGuard)
export class ReportsController {
  @Get('/posts')
  @Can('read', 'Post')
  posts() {
    return [];
  }

  @Get('/comments')
  // @ts-expect-error 'Comment' is not one of AppSubjects
  @Can('read', 'Comment')
  comments() {
    return [];
  }
}
// #endregion usage

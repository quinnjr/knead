import { describe, expect, test } from 'bun:test';
import type { Ctx } from '@knead-js/http';
import { RolesGuard, type User } from '../src/auth/auth.js';

const ctx = (meta: Record<PropertyKey, unknown>, user?: User) =>
  ({ meta, state: { user } }) as unknown as Ctx;

describe('RolesGuard', () => {
  const guard = new RolesGuard();
  const admin: User = { id: 'u1', name: 'Admin', roles: ['admin'] };
  const regular: User = { id: 'u2', name: 'Regular', roles: [] };

  test('strict: without @Roles() metadata it denies', () => {
    const admin: User = { id: 'u1', name: 'Admin', roles: ['admin'] };
    expect(guard.canActivate(ctx({}, admin))).toBe(false);
    expect(guard.canActivate(ctx({ roles: [] }, admin))).toBe(false);
  });

  test('reads required roles from ctx.meta and denies when they are unmet', () => {
    expect(guard.canActivate(ctx({ roles: ['admin'] }, admin))).toBe(true);
    expect(guard.canActivate(ctx({ roles: ['admin'] }, regular))).toBe(false);
    expect(guard.canActivate(ctx({ roles: ['admin'] }))).toBe(false);
  });
});

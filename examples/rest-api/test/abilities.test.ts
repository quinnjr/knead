import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AbilityService, fullGrant } from '@knead-js/casl';
import { Test, type TestingModule } from '@knead-js/testing';
import { AppModule } from '../src/app.module.js';
import { demoUsers } from '../src/auth/auth.js';
import { permissions } from '../src/auth/permissions.js';

let mod: TestingModule;
let abilities: AbilityService;
const { admin, regular } = demoUsers;

beforeAll(async () => {
  mod = await Test.createModule({ imports: [AppModule] }).compile({ development: false });
  abilities = mod.get(AbilityService);
});
afterAll(async () => {
  await mod.close();
});

describe('token grants', () => {
  test('an admin may be issued every level', async () => {
    expect(await abilities.validateGrant(admin, fullGrant(permissions))).toMatchObject({
      ok: true,
    });
  });

  test('a regular user may be issued read access only', async () => {
    expect(await abilities.validateGrant(regular, 'users:read')).toMatchObject({ ok: true });
    const write = await abilities.validateGrant(regular, 'users:write');
    expect(write).toEqual({
      ok: false,
      problems: [
        {
          reason: 'exceeds-user',
          area: 'users',
          level: 'write',
          action: 'create',
          subject: 'User',
        },
        {
          reason: 'exceeds-user',
          area: 'users',
          level: 'write',
          action: 'delete',
          subject: 'User',
        },
      ],
    });
  });

  test('unknown areas and levels are malformed', async () => {
    expect(await abilities.validateGrant(admin, 'users:owner')).toEqual({
      ok: false,
      problems: [{ reason: 'malformed' }],
    });
  });
});

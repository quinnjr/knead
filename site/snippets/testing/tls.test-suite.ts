import { expect, test } from 'bun:test';
import { Controller, type Ctx, Get } from '@knead-js/http';
import { Test } from '@knead-js/testing';

@Controller('/whoami')
class WhoAmIController {
  @Get('/')
  whoAmI(ctx: Ctx) {
    return { secure: ctx.secure };
  }
}

/** `certificate` is a self-signed test certificate for 127.0.0.1. */
export function tlsSuite(certificate: () => { cert: Bun.BunFile; key: Bun.BunFile }) {
  // #region tls
  test('serves HTTPS', async () => {
    const mod = await Test.createModule({ controllers: [WhoAmIController] }).compile();
    try {
      const app = await mod.createApp({ tls: certificate() });

      // Accepts the self-signed certificate: for tests only, never in application code.
      const res = await app.request('GET', '/whoami', { tls: { rejectUnauthorized: false } });

      expect(app.url.protocol).toBe('https:');
      expect(await res.json()).toEqual({ secure: true });
    } finally {
      await mod.close();
    }
  });
  // #endregion tls
}

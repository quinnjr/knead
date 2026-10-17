import { Module } from '@knead-js/core';
import { Controller, type Ctx, Get } from '@knead-js/http';
import { SecurityHeaders, SecurityHeadersModule } from '@knead-js/security-headers';

// #region page
@Controller('/')
export class PagesController {
  @Get('/')
  home(ctx: Ctx) {
    const nonce = ctx.state.cspNonce ?? '';
    return new Response(
      `<!doctype html><title>Home</title><script nonce="${nonce}">console.log('hi')</script>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  // Embeddable on one partner site; every other header keeps the module's value.
  @Get('/widget')
  @SecurityHeaders({
    contentSecurityPolicy: {
      directives: { 'frame-ancestors': ['https://partner.example.com'] },
    },
    xFrameOptions: false,
  })
  widget() {
    return new Response('<!doctype html><title>Widget</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}
// #endregion page

// #region module
@Module({
  imports: [
    SecurityHeadersModule.forRoot({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'https://cdn.example.com'],
          'connect-src': ["'self'", 'https://api.example.com'],
        },
        nonce: true,
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    }),
  ],
  controllers: [PagesController],
})
export class AppModule {}
// #endregion module

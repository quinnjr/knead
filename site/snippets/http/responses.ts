import { Controller, type Ctx, Get, Post } from '@knead-js/http';

// #region values
@Controller('/demo')
export class ResponsesController {
  @Get('/json')
  json() {
    return { ok: true }; // 200, application/json; charset=utf-8
  }

  @Get('/text')
  text() {
    return 'pong'; // 200, text/plain; charset=utf-8
  }

  @Get('/nothing')
  nothing() {
    // undefined: 204 No Content
  }

  @Get('/bytes')
  bytes() {
    return new TextEncoder().encode('raw'); // 200, application/octet-stream
  }

  @Get('/blob')
  blob() {
    return new Blob(['<svg/>'], { type: 'image/svg+xml' }); // the Blob's own type
  }

  @Get('/redirect')
  redirect() {
    return Response.redirect('https://example.com/', 302); // sent as is
  }
}
// #endregion values

// #region status
@Controller('/orders')
export class OrdersController {
  @Post('/', { status: 201 })
  create() {
    return { id: 'o_1' };
  }

  @Get('/:id')
  find(ctx: Ctx<{ params: { id: string } }>) {
    ctx.res.headers.set('cache-control', 'private, max-age=60');
    if (ctx.params.id === 'legacy') ctx.res.status = 203;
    return { id: ctx.params.id };
  }
}
// #endregion status

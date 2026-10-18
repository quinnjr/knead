import { Injectable, inject, Module } from '@knead-js/core';
import {
  All,
  Controller,
  type Ctx,
  Delete,
  Get,
  Head,
  NotFoundException,
  Options,
  Patch,
  Post,
  Put,
  requestUrl,
} from '@knead-js/http';

export interface Cat {
  id: string;
  name: string;
}

@Injectable()
export class CatsService {
  readonly #cats = new Map<string, Cat>([['1', { id: '1', name: 'Tom' }]]);

  list(): Cat[] {
    return [...this.#cats.values()];
  }

  find(id: string): Cat | undefined {
    return this.#cats.get(id);
  }

  remove(id: string): boolean {
    return this.#cats.delete(id);
  }
}

// #region controller
@Controller('/cats')
export class CatsController {
  readonly #cats = inject(CatsService);

  @Get('/')
  list() {
    return this.#cats.list();
  }

  @Get('/:id')
  find({ params }: Ctx<{ params: { id: string } }>) {
    const cat = this.#cats.find(params.id);
    if (!cat) throw new NotFoundException(`Cat ${params.id} not found`);
    return cat;
  }

  @Delete('/:id')
  remove({ params }: Ctx<{ params: { id: string } }>) {
    if (!this.#cats.remove(params.id)) throw new NotFoundException(`Cat ${params.id} not found`);
  }
}
// #endregion controller

// #region module
@Module({ controllers: [CatsController], providers: [CatsService] })
export class CatsModule {}
// #endregion module

// #region methods
@Controller('/methods')
export class MethodsController {
  @Get('/get') get() {
    return 'GET';
  }
  @Post('/post') post() {
    return 'POST';
  }
  @Put('/put') put() {
    return 'PUT';
  }
  @Patch('/patch') patch() {
    return 'PATCH';
  }
  @Delete('/delete') remove() {
    return 'DELETE';
  }
  @Head('/head') head(ctx: Ctx) {
    ctx.res.headers.set('x-head', 'yes');
  }
  @Options('/options') options() {
    return 'OPTIONS';
  }
  // GET, POST, PUT, PATCH, DELETE and OPTIONS (HEAD is answered by the GET handler).
  @All('/all') all(ctx: Ctx) {
    return ctx.req.method;
  }
}
// #endregion methods

// #region params
@Controller('/owners')
export class OwnersController {
  @Get('/:ownerId/cats/:catId')
  cat({ params }: Ctx<{ params: { ownerId: string; catId: string } }>) {
    return { owner: params.ownerId, cat: params.catId };
  }

  // An exact path is matched before a parameterized one, whatever the declaration order.
  @Get('/me')
  me() {
    return { owner: 'me' };
  }
}
// #endregion params

// #region wildcard
@Controller('/assets')
export class AssetsController {
  // Matches /assets/ and everything below it. The matched rest is not in ctx.params.
  @Get('/*')
  asset(ctx: Ctx) {
    return { path: requestUrl(ctx.req).pathname.slice('/assets/'.length) };
  }
}
// #endregion wildcard

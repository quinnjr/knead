import { inject, Module } from '@knead-js/core';
import { Controller, type Ctx, Get, KneadFactory } from '@knead-js/http';

class Greeter {
  greet(name: string) {
    return `hello ${name}`;
  }
}

@Controller('/greet')
class GreetController {
  readonly greeter = inject(Greeter);

  @Get('/:name')
  greet({ params }: Ctx<{ params: { name: string } }>) {
    return { message: this.greeter.greet(params.name) };
  }
}

@Module({ controllers: [GreetController], providers: [Greeter] })
class AppModule {}

const app = await KneadFactory.create(AppModule);
await app.listen({ port: 3000 });

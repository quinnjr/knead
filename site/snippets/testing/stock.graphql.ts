import { Injectable, inject, Module } from '@knead-js/core';
import {
  Field,
  GraphQLModule,
  ID,
  Int,
  Mutation,
  ObjectType,
  PUBSUB,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '@knead-js/graphql';

@ObjectType()
export class StockLevel {
  @Field(() => ID) sku!: string;
  @Field(() => Int) quantity!: number;
}

@Injectable()
export class StockService {
  readonly #levels = new Map<string, number>([['KETTLE-1', 12]]);

  get(sku: string): StockLevel | null {
    const quantity = this.#levels.get(sku);
    return quantity === undefined ? null : { sku, quantity };
  }

  set(sku: string, quantity: number): StockLevel {
    this.#levels.set(sku, quantity);
    return { sku, quantity };
  }
}

@Resolver(() => StockLevel)
export class StockResolver {
  readonly #stock = inject(StockService);
  readonly #pubsub = inject(PUBSUB);

  @Query(() => StockLevel, { nullable: true, args: { sku: ID } })
  stock(ctx: ResolverCtx<{ sku: string }>) {
    return this.#stock.get(ctx.args.sku);
  }

  @Mutation(() => StockLevel, { args: { sku: ID, quantity: Int } })
  async setStock(ctx: ResolverCtx<{ sku: string; quantity: number }>) {
    const level = this.#stock.set(ctx.args.sku, ctx.args.quantity);
    await this.#pubsub.publish('stock', { ...level });
    return level;
  }

  @Subscription(() => StockLevel, { topic: 'stock' })
  stockChanged() {}
}

@Module({
  imports: [GraphQLModule.forRoot()],
  providers: [StockService, StockResolver],
})
export class StockModule {}

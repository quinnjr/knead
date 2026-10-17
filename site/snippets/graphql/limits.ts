import { Module } from '@knead-js/core';
import { Field, GraphQLModule, Int, ObjectType, Query, Resolver } from '@knead-js/graphql';

// #region complexity
@ObjectType()
export class Report {
  @Field(() => Int) id!: number;
  // Each selection of `rows` costs 25 instead of 1.
  @Field(() => [String], { complexity: 25 }) rows!: string[];
}

@Resolver()
export class ReportResolver {
  @Query(() => [Report], { complexity: 10 })
  reports(): Report[] {
    return [{ id: 1, rows: ['a', 'b'] }];
  }
}
// #endregion complexity

// #region limits
@Module({
  imports: [
    GraphQLModule.forRoot({
      // Measured against the largest operation the web client sends, plus headroom.
      maxDepth: 15,
      maxFields: 5000,
      parseOptions: { maxTokens: 20_000 },
      maxComplexity: 2000,
    }),
  ],
  providers: [ReportResolver],
})
export class ReportsAppModule {}
// #endregion limits

import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@knead-js/core';
import { BadRequestException, type Ctx } from '@knead-js/http';
import { OperationContext } from '../src/context.js';
import {
  Field,
  type GraphQLModuleOptions,
  GraphQLRuntime,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  type ResolverCtx,
  Subscription,
} from '../src/index.js';
import { type Started, startGraphQL } from './helpers.js';

@ObjectType()
class Tree {
  @Field(() => Int) n!: number;
  @Field(() => Tree) child!: Tree;
}

const tree: Tree = {
  n: 1,
  get child() {
    return tree;
  },
};

let changes = 0;

@Resolver()
class R {
  @Query(() => Int, { nullable: true, args: { x: { type: () => Int, nullable: true } } }) n(
    ctx: ResolverCtx<{ x: number | null | undefined }>,
  ) {
    return ctx.args.x ?? 1;
  }
  @Query(() => String, { nullable: true }) boom(): string {
    throw new Error('resolver failed');
  }
  @Query(() => String) required(): string {
    throw new Error('non-null failed');
  }
  @Query(() => Tree) tree() {
    return tree;
  }
  @Query(() => Int, { complexity: 2000 }) expensive() {
    return 1;
  }
  @Mutation(() => Int) change() {
    return ++changes;
  }
  @Subscription(() => Int, { topic: 't' }) t() {}
}

@Module({ providers: [R] })
class M {}

const limits: GraphQLModuleOptions = { maxFields: 5, maxAliases: 1, maxDepth: 3 };

let s: Started | undefined;
afterEach(async () => {
  await s?.mod.close();
  s = undefined;
  changes = 0;
});

async function start(options: GraphQLModuleOptions = {}): Promise<GraphQLRuntime> {
  s = await startGraphQL([M], { ...limits, ...options });
  return s.mod.get(GraphQLRuntime);
}

const op = (allowed: ('query' | 'mutation' | 'subscription')[] = ['query', 'mutation']) =>
  new OperationContext({} as Ctx, {}, allowed);

async function classify(
  runtime: GraphQLRuntime,
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
) {
  const { response } = await runtime.executor.execute({ query, variables, operationName }, op());
  return { response, requestError: runtime.executor.isRequestError(response) };
}

describe('GraphQLExecutor.isRequestError', () => {
  describe('true when nothing ran (Leaven marks the rejection)', () => {
    test('a syntax error', async () => {
      const runtime = await start();
      expect((await classify(runtime, '{ n')).requestError).toBe(true);
    });

    test('a validation error', async () => {
      const runtime = await start();
      expect((await classify(runtime, '{ nope }')).requestError).toBe(true);
    });

    test('a variable that does not coerce (normalized to BAD_USER_INPUT, still marked)', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, 'query ($x: Int!) { n(x: $x) }', {
        x: 'a',
      });
      // normalizeResponse copies the response to recode BAD_REQUEST: the copy keeps the mark.
      expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(requestError).toBe(true);
    });

    test('an unknown operationName', async () => {
      const runtime = await start();
      expect((await classify(runtime, 'query A { n }', undefined, 'B')).requestError).toBe(true);
    });

    test('maxComplexity (Leaven runs the check in its pipeline)', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ expensive }');
      expect(response.errors?.[0]?.extensions?.code).toBe('COMPLEXITY_LIMIT');
      expect(requestError).toBe(true);
    });
  });

  describe("true for Knead's pre-execution checks (an onParsed hook throw, marked by Leaven)", () => {
    test('maxFields', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ n n n n n n }');
      expect(response.errors?.[0]?.extensions?.code).toBe('FIELD_LIMIT');
      expect(requestError).toBe(true);
    });

    test('maxAliases', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ a: n b: n }');
      expect(response.errors?.[0]?.message).toContain('aliases');
      expect(requestError).toBe(true);
    });

    test('maxDepth', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(
        runtime,
        '{ tree { child { child { n } } } }',
      );
      expect(response.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
      expect(requestError).toBe(true);
    });

    test('maxIntrospectionDepth', async () => {
      const runtime = await start({ maxIntrospectionDepth: 1 });
      const { response, requestError } = await classify(runtime, '{ __schema { types { name } } }');
      expect(response.errors?.[0]?.extensions?.code).toBe('DEPTH_LIMIT');
      expect(requestError).toBe(true);
    });

    test('a user onParsed hook that throws (it runs before validation)', async () => {
      const runtime = await start({
        hooks: {
          onParsed: () => {
            throw new BadRequestException('refused');
          },
        },
      });
      expect((await classify(runtime, '{ n }')).requestError).toBe(true);
    });

    for (const hook of ['onParse', 'onValidate', 'onValidated'] as const) {
      test(`a user ${hook} hook that throws`, async () => {
        let calls = 0;
        const runtime = await start({
          hooks: {
            [hook]: () => {
              calls++;
              throw new BadRequestException('refused');
            },
          },
        });
        const { response, requestError } = await classify(runtime, 'mutation { change }');
        expect(calls).toBe(1);
        expect(response.data).toBeUndefined();
        expect(changes).toBe(0);
        expect(requestError).toBe(true);
      });
    }

    test('overlapping calls keep their own classification', async () => {
      // One call's hook throws while another call (a mutation) is between its hooks: the mark is
      // per response, so the mutation that ran is not marked, and the refused call is. The
      // mutation's onExecuted throws, so its response has no data and only the mark tells the two
      // apart.
      const refusing = Promise.withResolvers<void>();
      const running = Promise.withResolvers<void>();
      const refusedEntered = Promise.withResolvers<void>();
      const mutationEntered = Promise.withResolvers<void>();
      const runtime = await start({
        hooks: {
          onParsed: async (document: { loc?: { source: { body: string } } }) => {
            if (document.loc?.source.body.includes('refuse')) {
              refusedEntered.resolve();
              await refusing.promise;
              throw new BadRequestException('refused');
            }
            mutationEntered.resolve();
            await running.promise;
          },
          onExecuted: () => {
            throw new BadRequestException('after the fact');
          },
        },
      });
      const mutation = classify(runtime, 'mutation { change }');
      const refused = classify(runtime, 'query refuse { n }');
      // Both calls are inside onParsed; the refused one fails while the mutation still waits.
      await Promise.all([refusedEntered.promise, mutationEntered.promise]);
      refusing.resolve();
      const rejected = await refused;
      expect(changes).toBe(0);
      running.resolve();
      const ran = await mutation;
      expect(ran.response.data).toBeUndefined();
      expect(changes).toBe(1);
      expect(ran.requestError).toBe(false);
      expect(rejected.requestError).toBe(true);
    });

    test('a document cache that throws (Leaven fails before execution)', async () => {
      const failing = () => {
        throw new Error('cache down');
      };
      const runtime = await start({
        cache: {
          get: failing,
          set: () => {},
          getWithValidation: failing,
          setValidation: () => {},
          setWithValidation: () => {},
          has: () => false,
          delete: () => false,
          clear: () => {},
          getStats: () => ({ size: 0, maxSize: 0, hits: 0, misses: 0, hitRate: 0 }),
        } as never,
      });
      const { response, requestError } = await classify(runtime, '{ n }');
      expect(response.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(requestError).toBe(true);
    });
  });

  describe('false once execution started', () => {
    test('a resolver that throws', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ boom }');
      expect(response.data).toEqual({ boom: null });
      expect(requestError).toBe(false);
    });

    test('a result with data: null', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ required }');
      expect(response.data).toBeNull();
      expect(requestError).toBe(false);
    });

    test('a successful query', async () => {
      const runtime = await start();
      const { response, requestError } = await classify(runtime, '{ n }');
      expect(response).toEqual({ data: { n: 1 } });
      expect(requestError).toBe(false);
    });

    test('an onExecuted hook that throws a BAD_USER_INPUT error after a mutation ran', async () => {
      // Not classified by error code: the alias check's BAD_USER_INPUT code is shared with
      // errors raised after execution, and a mutation that ran must never read as a request error.
      const runtime = await start({
        hooks: {
          onExecuted: () => {
            throw new BadRequestException('after the fact');
          },
        },
      });
      const { response, requestError } = await classify(runtime, 'mutation { change }');
      expect(response.data).toBeUndefined();
      expect(response.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(changes).toBe(1);
      expect(requestError).toBe(false);
    });

    test('an onExecute hook that throws (execution had started)', async () => {
      const runtime = await start({
        hooks: {
          onExecute: () => {
            throw new BadRequestException('refused late');
          },
        },
      });
      const { response, requestError } = await classify(runtime, '{ n }');
      expect(response.data).toBeUndefined();
      expect(requestError).toBe(false);
    });

    test('a response this executor did not return', async () => {
      const runtime = await start();
      expect(runtime.executor.isRequestError({ errors: [{ message: 'x' }] })).toBe(false);
    });
  });

  test('a mutation on a query-only OperationContext sets rejectedOperation (Task 5 answers it)', async () => {
    const runtime = await start();
    const context = op(['query']);
    await runtime.executor.execute({ query: 'mutation { change }' }, context);
    expect(context.rejectedOperation).toBe('mutation');
    expect(changes).toBe(0);
  });

  describe('subscribe', () => {
    test('true for a syntax error and for a Knead check', async () => {
      const runtime = await start();
      for (const query of ['subscription { t', 'subscription { t t t t t t }']) {
        const result = await runtime.executor.subscribe(
          { query },
          op(['query', 'mutation', 'subscription']),
        );
        // A response, not an iterator (narrows the type for isRequestError).
        if (Symbol.asyncIterator in result) throw new Error(`${query} returned an iterator`);
        expect(runtime.executor.isRequestError(result)).toBe(true);
      }
    });
  });
});

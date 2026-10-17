import { describe, expect, test } from 'bun:test';
import { GraphQLEnumType } from 'graphql';
import { defineEnum, defineScalar, defineUnion, Float, ID, Int } from '../src/index.js';

describe('type handles', () => {
  test('built-in scalar handles wrap the graphql-js scalars', () => {
    expect([ID.graphql.name, Int.graphql.name, Float.graphql.name]).toEqual(['ID', 'Int', 'Float']);
    expect(ID.__kind).toBe('scalar');
    expect(Object.isFrozen(ID)).toBe(true);
  });

  test('defineEnum uses keys as names and skips numeric reverse mappings', () => {
    enum Level {
      LOW,
      HIGH,
    }
    const handle = defineEnum(Level, {
      name: 'Level',
      valuesConfig: { HIGH: { description: 'Loud' } },
    });
    expect(handle.graphql).toBeInstanceOf(GraphQLEnumType);
    expect(handle.graphql.getValues().map((v) => [v.name, v.value, v.description])).toEqual([
      ['LOW', 0, undefined],
      ['HIGH', 1, 'Loud'],
    ]);
  });

  test('defineEnum keeps numeric-looking names such as Infinity', () => {
    const Bound = { Infinity: 'inf', NaN: 'nan', Zero: 0 } as const;
    const handle = defineEnum(Bound, { name: 'Bound' });
    expect(handle.graphql.getValues().map((v) => [v.name, v.value])).toEqual([
      ['Infinity', 'inf'],
      ['NaN', 'nan'],
      ['Zero', 0],
    ]);
  });

  test('defineEnum skips only true reverse mappings of a numeric enum', () => {
    enum Mixed {
      ONE = 1,
      TWO = 'two',
    }
    expect(
      defineEnum(Mixed, { name: 'Mixed' })
        .graphql.getValues()
        .map((v) => [v.name, v.value]),
    ).toEqual([
      ['ONE', 1],
      ['TWO', 'two'],
    ]);
    // A string value naming another key with a number is not a reverse mapping unless it maps back.
    const Pointer = { A: 'B', B: 1 } as const;
    expect(
      defineEnum(Pointer, { name: 'Pointer' })
        .graphql.getValues()
        .map((v) => v.name),
    ).toEqual(['A', 'B']);
  });

  test('defineEnum rejects an empty object', () => {
    expect(() => defineEnum({}, { name: 'Nothing' })).toThrow('Enum Nothing has no values.');
  });

  test('defineScalar requires a GraphQLScalarType', () => {
    expect(() => defineScalar({ name: 'X' } as never)).toThrow(TypeError);
  });

  test('defineUnion keeps the thunk lazy', () => {
    let called = false;
    const handle = defineUnion({
      name: 'U',
      types: () => {
        called = true;
        return [];
      },
    });
    expect(handle.__kind).toBe('union');
    expect(called).toBe(false);
  });
});

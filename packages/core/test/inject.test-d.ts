import { InjectionToken, inject } from '../src/index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => {};

class SomeClass {
  readonly x = 1;
}
const OBJ = new InjectionToken<{ url: string }>('X');

// Never invoked: only type-checked.
export function typeAssertions(): void {
  const obj = inject(OBJ);
  assertType<Equal<typeof obj, { url: string }>>();
  const inst = inject(SomeClass);
  assertType<Equal<typeof inst, SomeClass>>();
  const opt = inject(OBJ, { optional: true });
  assertType<Equal<typeof opt, { url: string } | undefined>>();
  // @ts-expect-error a string token does not produce a number
  const n: number = inject(new InjectionToken<string>('S'));
  void n;
}

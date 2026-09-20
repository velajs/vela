/** Compile-time API regressions (included by tsconfig.typecheck.json). */
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import { memoryAdapter } from '../adapter';

const schema = z.object({ id: z.string(), score: z.number() });
const typed = memoryAdapter({ tableName: 'typed', parseRow: (value) => schema.parse(value) });
const loose = memoryAdapter({ tableName: 'loose' });
expectTypeOf<Awaited<ReturnType<typeof typed.create>>>().toEqualTypeOf<z.infer<typeof schema>>();
expectTypeOf<Awaited<ReturnType<typeof loose.create>>>().toEqualTypeOf<Record<string, unknown>>();
async function typedCalls() {
  return typed.requestScope(async (scope) => {
    // @ts-expect-error score keeps the decoder's numeric type.
    await typed.create({ id: 'a', score: 'wrong' }, scope);
    const row = await typed.readOne({ field: 'id', value: 'a' }, {}, scope);
    if (row) expectTypeOf(row.score).toEqualTypeOf<number>();
  });
}
void typedCalls;

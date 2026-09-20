import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';

import type {
  CrudHooks,
  HookContext,
  HookModeConfig,
  SchemaHooks,
  SchemaWrite,
} from './hook-types';

const recordSchema = z.record(z.string(), z.unknown());
const pageSchema = z
  .object({
    result: z.array(z.unknown()),
    result_info: z
      .object({
        page: z.number(),
        per_page: z.number(),
        total_count: z.number().optional(),
        total_pages: z.number().optional(),
        has_next_page: z.boolean(),
        has_prev_page: z.boolean(),
        next_cursor: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Shared parser factory keeps public payload aliases tied to these exact schemas. */
export function createHookSchemas<Shape extends ZodRawShape>(schema: ZodObject<Shape>) {
  return {
    persisted: schema.passthrough(),
    partial: schema.partial().passthrough(),
  };
}

type RecordValue = Record<string, unknown>;
type Parser<Value> = (value: unknown) => Value;
type Mutation<Value, Extra extends unknown[]> = (
  ctx: HookContext,
  value: Value,
  ...extra: Extra
) => Value | void | Promise<Value | void>;

/** Keep in-place mutations visible even when the selected mode ignores returns. */
function synchronizeOwnProperties(target: object, value: object): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(value, key) && !Reflect.deleteProperty(target, key)) {
      throw new TypeError(`Cannot remove hook-mutated field ${key}`);
    }
  }
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(value));
}

function completeMutation<Value extends object>(
  parse: Parser<Value>,
  runtimeValue: object,
  parsedValue: Value,
  result: Value | void | Promise<Value | void>,
): Value | void | Promise<Value | void> {
  const complete = (replacement: Value | void): Value | void => {
    if (replacement !== undefined) return parse(replacement);
    // Copy only after successful validation, so a bad mutation cannot leak
    // into the engine's payload. Returning void retains hook-mode semantics.
    synchronizeOwnProperties(runtimeValue, parse(parsedValue));
  };
  // Finish synchronous hooks synchronously: a fire-and-forget hook can mutate
  // its payload before the engine continues, just as an uncompiled hook can.
  return result instanceof Promise ? result.then(complete) : complete(result);
}

function compileMutation<Value extends RecordValue, Extra extends unknown[]>(
  parse: Parser<Value>,
  hook: Mutation<Value, Extra> | undefined,
): Mutation<RecordValue, Extra> | undefined {
  if (!hook) return undefined;
  return async (ctx, value, ...extra) => {
    const parsed = parse(value);
    return completeMutation(parse, value, parsed, hook(ctx, parsed, ...extra));
  };
}

function compileObserver<Value, Extra extends unknown[]>(
  parse: Parser<Value>,
  hook: ((ctx: HookContext, value: Value, ...extra: Extra) => void | Promise<void>) | undefined,
): ((ctx: HookContext, value: RecordValue, ...extra: Extra) => Promise<void>) | undefined {
  if (!hook) return undefined;
  return async (ctx, value, ...extra) => {
    await hook(ctx, parse(value), ...extra);
  };
}

function compileTransform<Value>(
  parse: Parser<Value>,
  hook: ((ctx: HookContext, value: Value) => unknown | Promise<unknown>) | undefined,
): ((ctx: HookContext, value: RecordValue) => Promise<unknown>) | undefined {
  if (!hook) return undefined;
  return async (ctx, value) => hook(ctx, parse(value));
}

/**
 * Compile schema-aware author callbacks into the kernel's runtime record view.
 * Every row crossing into a typed callback is parsed; replacements are parsed
 * again before re-entering the engine. Read transforms deliberately return
 * unknown, so they can produce scalars, arrays, or a different object shape.
 */
export function compileHooks<Shape extends ZodRawShape>(
  schema: ZodObject<Shape>,
  hooks: SchemaHooks<Shape> | undefined,
): (CrudHooks<RecordValue> & HookModeConfig) | undefined {
  if (!hooks) return undefined;

  const { persisted, partial } = createHookSchemas(schema);
  const parseRow = (value: unknown) => persisted.parse(value);
  const parsePartial = (value: unknown): SchemaWrite<Shape> => {
    const input = recordSchema.parse(value);
    const parsed = partial.parse(input);
    // Zod 4 applies nested defaults even under optional(). Missing PATCH or
    // masked fields must stay absent: defaults must never resurrect hidden
    // fields or overwrite stored values that the caller did not update.
    for (const key of Object.keys(parsed)) {
      if (!Object.hasOwn(input, key)) delete parsed[key];
    }
    return parsed;
  };

  const beforeUpdate = hooks.beforeUpdate;
  const afterUpdate = hooks.afterUpdate;
  const afterList = hooks.afterList;

  return {
    beforeMode: hooks.beforeMode,
    afterMode: hooks.afterMode,
    modes: hooks.modes,
    beforeCreate: compileMutation(parsePartial, hooks.beforeCreate),
    afterCreate: compileMutation(parseRow, hooks.afterCreate),
    beforeUpdate:
      beforeUpdate &&
      (async (ctx, patch, prior) => {
        const parsed = parsePartial(patch);
        return completeMutation(
          parsePartial,
          patch,
          parsed,
          beforeUpdate(ctx, parsed, parseRow(prior)),
        );
      }),
    afterUpdate:
      afterUpdate &&
      (async (ctx, prior, current) => {
        const parsed = parseRow(current);
        return completeMutation(
          parseRow,
          current,
          parsed,
          afterUpdate(ctx, parseRow(prior), parsed),
        );
      }),
    beforeDelete: compileObserver(parseRow, hooks.beforeDelete),
    afterDelete: compileObserver(parseRow, hooks.afterDelete),
    beforeList: hooks.beforeList,
    afterList:
      afterList &&
      (async (ctx, page) => {
        const parsed = pageSchema.parse(page);
        return completeMutation(
          (value) => pageSchema.parse(value),
          page,
          parsed,
          afterList(ctx, parsed),
        );
      }),
    transformList: compileTransform(parsePartial, hooks.transformList),
    beforeRead: hooks.beforeRead,
    afterRead: compileMutation(parseRow, hooks.afterRead),
    transformRead: compileTransform(parsePartial, hooks.transformRead),
    beforeUpsert: compileMutation(parsePartial, hooks.beforeUpsert),
    afterUpsert: compileMutation(parseRow, hooks.afterUpsert),
    beforeBatchCreate: compileMutation(parsePartial, hooks.beforeBatchCreate),
    afterBatchCreate: compileMutation(parseRow, hooks.afterBatchCreate),
    beforeBatchUpdate: compileMutation(parsePartial, hooks.beforeBatchUpdate),
    afterBatchUpdate: compileMutation(parseRow, hooks.afterBatchUpdate),
    beforeBatchDelete: compileObserver(parseRow, hooks.beforeBatchDelete),
    afterBatchDelete: compileObserver(parseRow, hooks.afterBatchDelete),
    beforeBatchRestore: compileObserver(parseRow, hooks.beforeBatchRestore),
    afterBatchRestore: compileMutation(parseRow, hooks.afterBatchRestore),
    beforeBatchUpsert: compileMutation(parsePartial, hooks.beforeBatchUpsert),
    afterBatchUpsert: compileMutation(parseRow, hooks.afterBatchUpsert),
  };
}

/** Longest query name a `sub` frame carries. */
const MAX_LIVE_QUERY_NAME_LENGTH = 256;

/**
 * One live query's shared contract: the wire name clients subscribe with and
 * two portable runtime schemas. Zod and other parsers implement `parse`
 * directly.
 */
export interface LiveQueryDefinition<
  Name extends string = string,
  Args = unknown,
  Result = unknown,
> {
  /** The name clients subscribe with; unique within an application. */
  readonly name: Name;
  readonly args: { parse(value: unknown): Args };
  readonly result: { parse(value: unknown): Result };
}

/**
 * Declare a live query once, with its name, and share the definition between
 * the server's `@LiveQuery` resolver and the typed client. The name must be a
 * non-empty string of at most 256 characters.
 */
export function defineLiveQuery<Name extends string, Args, Result>(
  definition: LiveQueryDefinition<Name, Args, Result>,
): LiveQueryDefinition<Name, Args, Result> {
  const { name } = definition;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LIVE_QUERY_NAME_LENGTH) {
    throw new TypeError(
      `A live query name must be a non-empty string of at most ${MAX_LIVE_QUERY_NAME_LENGTH} characters.`,
    );
  }
  return definition;
}

/** A portable runtime schema: Zod and other parsers can implement this directly. */
export interface LiveQueryDefinition<Args, Result> {
  readonly args: { parse(value: unknown): Args };
  readonly result: { parse(value: unknown): Result };
}

/** Share one args/result contract between a resolver and its typed client. */
export function defineLiveQuery<Args, Result>(
  definition: LiveQueryDefinition<Args, Result>,
): LiveQueryDefinition<Args, Result> {
  return definition;
}

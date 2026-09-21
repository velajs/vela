import {
  buildSchema,
  findBreakingChanges,
  findDangerousChanges,
  lexicographicSortSchema,
  type GraphQLSchema,
} from 'graphql';
import { printSchemaWithDirectives } from '@graphql-tools/utils';

/** Pure helpers: filesystem ownership belongs to the application's Node/CI script. */
export function printGraphqlSchema(schema: GraphQLSchema): string {
  return printSchemaWithDirectives(lexicographicSortSchema(schema)) + '\n';
}

export function compareGraphqlSchema(baselineSDL: string, current: GraphQLSchema) {
  const baseline = buildSchema(baselineSDL);
  const breaking = findBreakingChanges(baseline, current);
  const dangerous = findDangerousChanges(baseline, current);
  return { compatible: breaking.length === 0, breaking, dangerous };
}

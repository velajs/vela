import { describe, expect, it } from 'vitest';
import { buildSchema } from 'graphql';
import { compareGraphqlSchema, printGraphqlSchema } from '../schema';

describe('schema compatibility', () => {
  it('prints deterministically and detects field removal and new required arguments', () => {
    const baseline = buildSchema('type Query { b: String a: String }');
    expect(printGraphqlSchema(baseline)).toBe(
      printGraphqlSchema(buildSchema('type Query { a: String b: String }')),
    );
    const result = compareGraphqlSchema(
      printGraphqlSchema(baseline),
      buildSchema('type Query { a(id: ID!): String }'),
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((change) => change.description.includes('b'))).toBe(true);
    expect(result.breaking.some((change) => change.description.includes('id'))).toBe(true);
  });
  it('accepts additive fields and rejects malformed baselines', () => {
    expect(
      compareGraphqlSchema(
        'type Query { a: String }',
        buildSchema('type Query { a: String b: String }'),
      ).compatible,
    ).toBe(true);
    expect(() =>
      compareGraphqlSchema('malformed', buildSchema('type Query { a: String }')),
    ).toThrow();
  });
  it('preserves applied directives in the exported SDL', () => {
    const schema = buildSchema(
      'directive @scope(name: String!) on FIELD_DEFINITION type Query { a: String @scope(name: "read") }',
    );
    expect(printGraphqlSchema(schema)).toContain('@scope(name: "read")');
  });
});

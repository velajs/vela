import { describe, expect, it } from 'vitest';
import { MetadataRegistry } from '@velajs/vela/module-kit';
import { buildSchema } from 'graphql';
import { GraphqlModule } from '../module';

const options = {
  schema: buildSchema('type Query { value: String }'),
  driver: {
    create() {
      throw new Error('Route validation must not initialize the driver');
    },
  },
};

describe('GraphQL route validation', () => {
  it('defaults to /graphql', () => {
    const module = GraphqlModule.forRoot(options);
    expect(MetadataRegistry.getControllerPath(module.controllers![0]!)).toBe('/graphql');
  });

  it.each(['/', '/graphql', '/v1/graphql', '/A_b-C9/0/_/-'])(
    'preserves the literal route %s',
    (path) => {
      const module = GraphqlModule.forRoot({ ...options, path });
      expect(MetadataRegistry.getControllerPath(module.controllers![0]!)).toBe(path);
    },
  );

  it.each([
    '',
    'graphql',
    '//',
    '/graphql/',
    '/graphql//nested',
    '//graphql',
    '/graphql?x=1',
    '/graphql#x',
    '/graphql/*',
    '/graphql/:id',
    '/graphql/{id}',
    '/a.b',
    '/graphql\\admin',
    '/gráphql',
    '/graph ql',
    '/graphql\n',
    '/graphql\r',
    '/graphql\r\n',
    '/graphql\u2028',
    '/graphql\0',
  ])('rejects non-literal or malformed route %j', (path) => {
    expect(() => GraphqlModule.forRoot({ ...options, path })).toThrow(TypeError);
  });

  it('handles long segments and many segments without changing the accepted grammar', () => {
    const paths = ['/' + '-'.repeat(100_000), '/' + 'segment/'.repeat(10_000) + 'last'];
    for (const path of paths) {
      const module = GraphqlModule.forRoot({ ...options, path });
      expect(MetadataRegistry.getControllerPath(module.controllers![0]!)).toBe(path);
      // Invalid terminal characters forced exponential backtracking in the previous regex.
      for (const suffix of ['!', '\n', '/', '//last']) {
        expect(() => GraphqlModule.forRoot({ ...options, path: path + suffix })).toThrow(TypeError);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { Module, VelaFactory, type ModuleImport } from '@velajs/vela';
import { MetadataRegistry } from '@velajs/vela/module-kit';
import { buildSchema } from 'graphql';
import { GraphqlModule, type GraphqlModuleOptions } from '../module';

const options: GraphqlModuleOptions = {
  schema: buildSchema('type Query { value: String }'),
  driver: {
    create() {
      throw new Error('Route validation must not initialize the driver');
    },
  },
};

/** The `/graphql` routes an application importing `imports` mounts. */
async function graphqlRoutes(imports: ModuleImport[]) {
  class App {}
  Module({ imports })(App);
  const app = await VelaFactory.create(App, { diagnostics: 'throw' });
  try {
    return app.describeRoutes().filter((route) => route.path === '/graphql');
  } finally {
    await app.close();
  }
}

describe('GraphQL route validation', () => {
  it('defaults to /graphql', () => {
    const module = GraphqlModule.forRoot(options);
    expect(MetadataRegistry.getControllerPath(module.controllers![0]!)).toBe('/graphql');
  });

  it('treats the default path spelled out as the default endpoint', async () => {
    const implicit = GraphqlModule.forRoot(options);
    const spelled = GraphqlModule.forRoot({ ...options, path: '/graphql' });
    expect(spelled.key).toBe(implicit.key);
    class App {}
    Module({ imports: [implicit, spelled] })(App);
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    expect(app.describeRoutes().filter((route) => route.path === '/graphql')).not.toHaveLength(0);
    await app.close();
  });

  it('treats empty imports spelled out as the default endpoint', async () => {
    const implicit = GraphqlModule.forRoot(options);
    const spelled = GraphqlModule.forRoot({ ...options, imports: [] });
    expect(spelled.key).toBe(implicit.key);
    const single = await graphqlRoutes([implicit]);
    expect(single).not.toHaveLength(0);
    expect(await graphqlRoutes([implicit, spelled])).toEqual(single);
  });

  it('rejects another imports list on the same path', async () => {
    class FieldPipelineModule {}
    Module({})(FieldPipelineModule);
    class App {}
    Module({
      imports: [
        GraphqlModule.forRoot(options),
        GraphqlModule.forRoot({ ...options, imports: [FieldPipelineModule] }),
      ],
    })(App);
    // Not a diagnostic: the default policy fails the bootstrap too.
    await expect(VelaFactory.create(App)).rejects.toThrow(/imported again with different options/);
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

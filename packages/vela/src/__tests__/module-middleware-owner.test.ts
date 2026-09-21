import { expect, it } from 'vitest';
import { Module, type MiddlewareConsumer, type NestMiddleware } from '../index';
import { bootstrap } from '../factory/bootstrap';

it('retains each configure() definition owner for HTTP middleware resolution', async () => {
  const middleware: NestMiddleware = { use: (_context, next) => next() };
  class Feature {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(middleware).forRoutes('/owned');
    }
  }
  @Module({
    imports: [
      { module: Feature, key: 'one' },
      { module: Feature, key: 'two' },
    ],
  })
  class Root {}
  const { loader, container } = await bootstrap(Root);
  expect(
    loader.getConsumerMiddlewareDefinitions().map((definition) => definition.moduleId),
  ).toEqual(['Feature#one', 'Feature#two']);
  await container.dispose();
});

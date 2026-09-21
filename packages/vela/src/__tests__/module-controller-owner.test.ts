import { expect, it } from 'vitest';
import {
  Controller,
  defineProvider,
  Get,
  Inject,
  InjectionToken,
  Module,
  VelaFactory,
} from '../index';

it('uses the mounted owner even when another module registered the class as a provider', async () => {
  const NAME = new InjectionToken<string>('controller owner');
  @Controller('/owned-controller')
  class Handler {
    constructor(@Inject(NAME) readonly name: string) {}
    @Get() handle() {
      return { name: this.name };
    }
  }
  @Module({ providers: [defineProvider(NAME, { useValue: 'provider only' }), Handler] })
  class ProviderModule {}
  @Module({ providers: [defineProvider(NAME, { useValue: 'mounted' })], controllers: [Handler] })
  class HttpModule {}
  @Module({ imports: [ProviderModule, HttpModule] })
  class Root {}
  const app = await VelaFactory.create(Root);
  expect(await (await app.getHonoApp().request('/owned-controller')).json()).toEqual({
    name: 'mounted',
  });
  await app.close();
});

it('rejects mounting the same controller class under two keyed module owners', async () => {
  @Controller('/ambiguous-controller')
  class Handler {
    @Get() handle() {
      return 'ambiguous';
    }
  }
  class Feature {}
  @Module({
    imports: ['one', 'two'].map((key) => ({ module: Feature, key, controllers: [Handler] })),
  })
  class Root {}
  await expect(VelaFactory.create(Root)).rejects.toThrow(
    /already mounted by module Feature#one.*module Feature#two/,
  );
});

it('registers additional controllers from repeated definitions of the same instance', async () => {
  @Controller('/first-controller')
  class First {
    @Get() handle() {
      return 'first';
    }
  }
  @Controller('/second-controller')
  class Second {
    @Get() handle() {
      return 'second';
    }
  }
  class Feature {}
  @Module({
    imports: [
      { module: Feature, key: 'one', controllers: [First] },
      { module: Feature, key: 'one', controllers: [First, Second] },
    ],
  })
  class Root {}
  const app = await VelaFactory.create(Root);
  expect((await app.getHonoApp().request('/first-controller')).status).toBe(200);
  expect((await app.getHonoApp().request('/second-controller')).status).toBe(200);
  expect(app.getContainer().getOwnerModuleIds(Second)).toEqual(['Feature#one']);
  await app.close();
});

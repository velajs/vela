import { expect, it } from 'vitest';
import {
  Controller,
  defineModule,
  Get,
  Injectable,
  Module,
  sideEffectModule,
  VelaFactory,
} from '../index';

it('deduplicates stable contribution owners, without globally interning names', async () => {
  let initialized = 0;
  @Injectable()
  class Service {
    onModuleInit() {
      initialized++;
    }
  }
  class Contributions {}
  const create = () =>
    sideEffectModule(Contributions, { providers: [Service], exports: [Service] });
  @Injectable()
  class Consumer {
    constructor(readonly service: Service) {}
  }
  @Module({ imports: [create(), create()], providers: [Consumer] })
  class Root {}
  const app = await VelaFactory.create(Root);
  expect(initialized).toBe(1);
  expect(app.get(Consumer).service).toBeInstanceOf(Service);
  expect(app.getContainer().getOwnerModuleIds(Service)).toHaveLength(1);
  const first = sideEffectModule('Contributions');
  const second = sideEffectModule('Contributions');
  expect(first.module).not.toBe(second.module);
  await app.close();
});

it('honors typed call-site lazy controls without constructing unused providers', async () => {
  let initialized = 0;
  @Injectable()
  class Service {
    onModuleInit() {
      initialized++;
    }
  }
  const { ConfigurableModuleClass } = defineModule<{ name: string }>({
    name: 'OnDemand',
    setup: () => ({ providers: [Service], exports: [Service] }),
  });
  class Feature extends ConfigurableModuleClass {}
  @Module({ imports: [Feature.forRoot({ name: 'one', lazy: true })] })
  class Root {}
  const app = await VelaFactory.create(Root);
  expect(initialized).toBe(0);
  expect(app.get(Service)).toBeInstanceOf(Service);
  expect(initialized).toBe(1);
  await app.close();
});

it('omits optional companion imports and controllers using async structural options', async () => {
  let initialized = 0;
  @Injectable()
  class Service {
    onModuleInit() {
      initialized++;
    }
  }
  @Module({ providers: [Service] })
  class Companion {}
  @Controller('/optional')
  class HttpController {
    @Get() get() {
      return 'enabled';
    }
  }
  const { ConfigurableModuleClass } = defineModule<{ http: boolean }>({
    name: 'OptionalHttp',
    setup: ({ options }) =>
      options.http ? { imports: [Companion], controllers: [HttpController] } : {},
  });
  class Feature extends ConfigurableModuleClass {}
  const root = (http: boolean) => {
    @Module({ imports: [Feature.forRootAsync({ http, inject: [], useFactory: () => ({ http }) })] })
    class Root {}
    return Root;
  };
  const disabled = await VelaFactory.create(root(false));
  expect(initialized).toBe(0);
  expect((await disabled.getHonoApp().request('/optional')).status).toBe(404);
  const enabled = await VelaFactory.create(root(true));
  expect(initialized).toBe(1);
  expect((await enabled.getHonoApp().request('/optional')).status).toBe(200);
  await Promise.all([disabled.close(), enabled.close()]);
});

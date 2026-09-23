import { describe, expect, it } from 'vitest';
import { ENV, Inject, Injectable, InjectionToken, Module, defineModule } from '@velajs/vela';
import type { VelaEnv } from '@velajs/vela';
import { countRegisteredClasses } from '@velajs/vela/internal';
import { createCloudflareApp, createCloudflareWorker } from '../cloudflare-factory';
import { VelaWebSocketDurableObject } from '../websocket/websocket.durable-object';

interface GreetingOptions {
  greeting: string;
}

const GREETING_OPTIONS = new InjectionToken<GreetingOptions>('test.cf.root.greeting');

const { ConfigurableModuleClass } = defineModule<GreetingOptions>({
  name: 'Greeting',
  optionsToken: GREETING_OPTIONS,
  setup: () => ({ exports: [GREETING_OPTIONS] }),
});

class GreetingModule extends ConfigurableModuleClass {}

@Injectable()
class Greeter {
  constructor(@Inject(GREETING_OPTIONS) readonly options: GreetingOptions) {}
}

/** One static root for every environment: bindings reach it through ENV. */
@Module({
  imports: [
    GreetingModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: VelaEnv): GreetingOptions => {
        const greeting: unknown = Reflect.get(env, 'GREETING');
        if (typeof greeting !== 'string') throw new TypeError('GREETING must be a string');
        return { greeting };
      },
    }),
  ],
  providers: [Greeter],
})
class AppModule {}

describe('Cloudflare roots', () => {
  it('configures one static root per environment through forRootAsync({ inject: [ENV] })', async () => {
    const a = await createCloudflareApp(AppModule, { env: { GREETING: 'a' } });
    const b = await createCloudflareApp(AppModule, { env: { GREETING: 'b' } });
    try {
      expect(a.get(Greeter).options).toEqual({ greeting: 'a' });
      expect(b.get(Greeter).options).toEqual({ greeting: 'b' });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('builds applications from a DynamicModule root without declaring classes', async () => {
    const root = { module: AppModule, key: 'dynamic-root' };
    const warm = await createCloudflareApp(root, { env: { GREETING: 'warm' } });
    await warm.close();
    const before = countRegisteredClasses();

    for (const greeting of ['one', 'two', 'three']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one environment at a time
      const app = await createCloudflareApp(root, { env: { GREETING: greeting } });
      expect(app.get(Greeter).options).toEqual({ greeting });
      // oxlint-disable-next-line eslint/no-await-in-loop -- close before the next environment
      await app.close();
    }

    expect(countRegisteredClasses()).toBe(before);
  });

  it('accepts only module roots', () => {
    const env = { GREETING: 'typed' };
    const typeOnly = (): void => {
      // @ts-expect-error environment-built roots are removed; configure through forRootAsync({ inject: [ENV] })
      void createCloudflareApp({ create: () => AppModule }, { env });
      // @ts-expect-error async environment-built roots are removed as well
      createCloudflareWorker({ create: async () => ({ module: AppModule }) });
      // @ts-expect-error a Durable Object is built from a module class or DynamicModule
      VelaWebSocketDurableObject({ create: () => AppModule });
    };
    void typeOnly;
  });
});

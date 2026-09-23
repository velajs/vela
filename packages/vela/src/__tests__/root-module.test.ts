import { describe, expect, it } from 'vitest';
import {
  Controller,
  ENV,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  ROOT_MODULE,
  VelaFactory,
  createOpenApiDocument,
  defineProvider,
  type DynamicModule,
  type Type,
} from '../index.js';
import { bootstrap, countRegisteredClasses } from '../internal.js';

const GREETING = new InjectionToken<string>('test.root.greeting');

@Controller('/hello')
class HelloController {
  constructor(@Inject(GREETING) private readonly greeting: string) {}

  @Get()
  hello(): { greeting: string } {
    return { greeting: this.greeting };
  }
}

/** A configurable root: its options arrive as a DynamicModule, not a wrapper class. */
class ApiModule {
  static forRoot(greeting: string): DynamicModule {
    return {
      module: ApiModule,
      providers: [defineProvider(GREETING, { useValue: greeting })],
      controllers: [HelloController],
    };
  }

  /** Environment-dependent configuration goes through DI, read from ENV per application. */
  static forEnvironment(): DynamicModule {
    return {
      module: ApiModule,
      key: 'environment',
      providers: [
        defineProvider(GREETING, {
          inject: [ENV],
          useFactory: (env) => {
            const greeting: unknown = Reflect.get(env, 'GREETING');
            if (typeof greeting !== 'string') throw new TypeError('GREETING must be a string');
            return greeting;
          },
        }),
      ],
      controllers: [HelloController],
    };
  }
}

async function greet(app: { fetch(request: Request): Response | Promise<Response> }) {
  const response = await app.fetch(new Request('http://localhost/hello'));
  return response.json();
}

describe('root modules', () => {
  it('creates an application from a DynamicModule root', async () => {
    const app = await VelaFactory.create(ApiModule.forRoot('hello'));
    try {
      expect(await greet(app)).toEqual({ greeting: 'hello' });
    } finally {
      await app.close();
    }
  });

  it('reads environment-dependent configuration through ENV for each application', async () => {
    const root = ApiModule.forEnvironment();
    const first = await VelaFactory.create(root, { env: { GREETING: 'first' } });
    const second = await VelaFactory.create(root, { env: { GREETING: 'second' } });
    try {
      expect(await greet(first)).toEqual({ greeting: 'first' });
      expect(await greet(second)).toEqual({ greeting: 'second' });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('bootstraps a dynamic root without declaring classes in the metadata registry', async () => {
    const root = ApiModule.forRoot('hello');
    const warm = await VelaFactory.create(root);
    await warm.close();
    const before = countRegisteredClasses();

    for (let index = 0; index < 3; index++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each bootstrap is measured in turn
      const { container } = await bootstrap(root);
      // oxlint-disable-next-line eslint/no-await-in-loop -- dispose before the next bootstrap
      await container.dispose();
    }

    expect(countRegisteredClasses()).toBe(before);
  });

  it('documents the controllers a dynamic root declares', () => {
    const document = createOpenApiDocument(ApiModule.forRoot('hello'));

    expect(Object.keys(document.paths)).toEqual(['/hello']);
  });

  it('provides the root as the global ROOT_MODULE', async () => {
    let seen: Type | DynamicModule | undefined;

    @Injectable()
    class RootReader {
      constructor(@Inject(ROOT_MODULE) root: Type | DynamicModule) {
        seen = root;
      }
    }

    @Module({ providers: [RootReader] })
    class FeatureModule {}

    @Module({ imports: [FeatureModule] })
    class AppModule {}

    const staticApp = await VelaFactory.create(AppModule);
    const dynamicRoot: DynamicModule = { module: AppModule, key: 'dynamic' };
    const dynamicApp = await VelaFactory.create(dynamicRoot);
    try {
      expect(staticApp.get(ROOT_MODULE)).toBe(AppModule);
      expect(dynamicApp.get(ROOT_MODULE)).toBe(dynamicRoot);
      // A feature module reads it without importing anything.
      expect(seen).toBe(dynamicRoot);
    } finally {
      await Promise.all([staticApp.close(), dynamicApp.close()]);
    }
  });
});

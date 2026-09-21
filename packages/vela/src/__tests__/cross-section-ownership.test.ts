import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  UseGuards,
  VelaFactory,
  defineDynamicModule,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
} from '../index';

describe('module ownership across HTTP guards and async DI', () => {
  it('keeps two dynamic registrations and two applications isolated through the pipeline', async () => {
    const ownerToken = new InjectionToken<string>('integration.owner');
    const disposed = new Set<string>();
    let nextId = 0;

    class Session {
      readonly #owner: string;
      readonly #id = String(++nextId);
      #checked = false;

      constructor(owner: string) {
        this.#owner = owner;
      }

      authorize(context: ExecutionContext): boolean {
        const route = new URL(context.getRequest().url).pathname.slice(1);
        this.#checked = this.#owner.endsWith(`:${route}`);
        return this.#checked;
      }

      snapshot() {
        return { owner: this.#owner, id: this.#id, checked: this.#checked };
      }

      dispose(): void {
        disposed.add(this.#id);
      }
    }

    @Injectable()
    class OwnerGuard implements CanActivate {
      constructor(@Inject(Session) private readonly session: Session) {}

      canActivate(context: ExecutionContext): boolean {
        return this.session.authorize(context);
      }
    }

    @Controller('/left')
    class LeftController {
      constructor(@Inject(Session) private readonly session: Session) {}

      @Get()
      @UseGuards(OwnerGuard)
      read() {
        return this.session.snapshot();
      }
    }

    @Controller('/right')
    class RightController {
      constructor(@Inject(Session) private readonly session: Session) {}

      @Get()
      @UseGuards(OwnerGuard)
      read() {
        return this.session.snapshot();
      }
    }

    @Module({})
    class Feature {}

    const createApp = async (appId: string) => {
      const feature = (side: 'left' | 'right') =>
        defineDynamicModule({
          module: Feature,
          key: side,
          providers: [
            defineProvider(ownerToken, { useValue: `${appId}:${side}` }),
            defineProvider(Session, {
              scope: Scope.REQUEST,
              inject: [ownerToken],
              useFactory: async (owner) => {
                await Promise.resolve();
                return new Session(owner);
              },
            }),
            OwnerGuard,
          ],
          controllers: [side === 'left' ? LeftController : RightController],
        });

      @Module({ imports: [feature('left'), feature('right')] })
      class App {}

      return VelaFactory.create(App);
    };

    const apps = await Promise.all([createApp('one'), createApp('two')]);
    try {
      const expected = ['one:left', 'one:right', 'two:left', 'two:right'];
      const responses = await Promise.all(
        apps.flatMap((app) => ['/left', '/right'].map((path) => app.getHonoApp().request(path))),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      const results = await Promise.all(responses.map((response) => response.json()));
      expect(results.map((result) => result.owner)).toEqual(expected);
      expect(results.every((result) => result.checked === true)).toBe(true);
      expect(new Set(results.map((result) => result.id)).size).toBe(4);
      await expect.poll(() => disposed.size).toBe(4);
    } finally {
      await Promise.all(apps.map((app) => app.dispose()));
    }
  });
});

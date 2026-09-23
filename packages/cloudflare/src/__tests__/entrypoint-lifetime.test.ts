import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Cron,
  EXECUTION_LIFETIME,
  REQUEST_CONTEXT,
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  Scope,
  UseGuards,
  defineProvider,
  getExecutionLifetime,
  type CanActivate,
  type Container,
  type ExecutionContext,
  type ExecutionLifetime,
} from '@velajs/vela';
import { createCloudflareApp } from '../cloudflare-factory';
import type { CloudflareApplication } from '../cloudflare-application';
import { QueueConsumer } from '../decorators/queue-consumer';

const kinds = ['queue', 'scheduled'] as const;
const event = { cron: '* * * * *', scheduledTime: 123 };
const batch = { queue: 'jobs', messages: [] };
function dispatch(
  app: CloudflareApplication,
  kind: (typeof kinds)[number],
  env: object,
  context = { waitUntil: (_promise: Promise<unknown>) => {} },
) {
  return kind === 'queue' ? app.queue(batch, env, context) : app.scheduled(event, env, context);
}
afterEach(() => MetadataRegistry.clear());

describe('native managed entrypoints', () => {
  it.each(kinds)('resolves each owning module asynchronously for %s handlers', async (kind) => {
    const NAME = new InjectionToken<string>('owner name');
    const VALUE = new InjectionToken<string>('async request value');
    const seen: string[] = [];
    const lifetimes: ExecutionLifetime[] = [];
    const scopes = new Set<Container>();
    class Guard implements CanActivate {
      constructor(readonly name: string) {}
      canActivate(context: ExecutionContext) {
        const scope = context.getContainer()!;
        const owner = context.getModuleId();
        expect(owner).toBeDefined();
        expect(scope.resolve(NAME, owner)).toBe(this.name);
        expect(getExecutionLifetime(scope)).toBe(scope.resolve(EXECUTION_LIFETIME, owner));
        expect(() => scope.resolve(REQUEST_CONTEXT, owner)).toThrow('inside a request');
        expect(() => context.getRequest()).toThrow('entrypoint');
        scopes.add(scope);
        seen.push(`guard:${this.name}`);
        return true;
      }
    }
    @Injectable()
    @UseGuards(Guard)
    class Job {
      constructor(
        @Inject(VALUE) readonly name: string,
        @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
      ) {}
      @QueueConsumer('jobs')
      @Cron('* * * * *', { dialect: 'cloudflare' })
      run(input: unknown) {
        if (kind === 'queue') expect(input).toBe(batch);
        else expect(input).toMatchObject({ kind: 'cron', expression: event.cron });
        lifetimes.push(this.lifetime);
        seen.push(`handler:${this.name}`);
        this.lifetime.defer(() => {
          seen.push(`deferred:${this.name}`);
        });
      }
    }
    class Feature {}
    @Module({
      imports: ['alpha', 'beta'].map((key) => ({
        module: Feature,
        key,
        lazy: true,
        providers: [
          Job,
          defineProvider(NAME, { useValue: key }),
          defineProvider(VALUE, {
            scope: Scope.REQUEST,
            inject: [NAME],
            useFactory: async (name) => name,
          }),
          defineProvider(Guard, {
            scope: Scope.REQUEST,
            inject: [NAME],
            useFactory: async (name) => new Guard(name),
          }),
        ],
      })),
    })
    class App {}
    const env = {};
    const app = await createCloudflareApp(App, { env });
    try {
      await dispatch(app, kind, env);
      expect(new Set(lifetimes.map((lifetime) => lifetime.id)).size).toBe(2);
      expect(lifetimes.every((lifetime) => !lifetime.active)).toBe(true);
      // Queue consumers run their declared guards; scheduled jobs run none,
      // exactly like the Node executor (signed dispatch runs a route's pipeline).
      expect(scopes.size).toBe(kind === 'queue' ? 2 : 0);
      for (const name of ['alpha', 'beta']) {
        if (kind === 'queue')
          expect(seen.indexOf(`guard:${name}`)).toBeLessThan(seen.indexOf(`handler:${name}`));
        else expect(seen).not.toContain(`guard:${name}`);
        expect(seen.indexOf(`handler:${name}`)).toBeLessThan(seen.indexOf(`deferred:${name}`));
      }
    } finally {
      await app.close();
    }
  });

  it.each(kinds)('retains %s resources through waitUntil and async disposal', async (kind) => {
    const work = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const events: string[] = [];
    const native: Promise<unknown>[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      async dispose() {
        events.push('disposing');
        await cleanup.promise;
        events.push('disposed');
      }
    }
    @Injectable()
    class Job {
      constructor(
        readonly resource: Resource,
        @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
      ) {}
      @QueueConsumer('jobs')
      @Cron('* * * * *', { dialect: 'cloudflare' })
      run(
        _input: unknown,
        _env?: object,
        context?: { waitUntil(promise: Promise<unknown>): void },
      ) {
        void this.resource;
        // Queue consumers keep the native context; scheduled jobs receive only
        // their invocation and extend the invocation through EXECUTION_LIFETIME.
        (context ?? this.lifetime).waitUntil(
          work.promise.then(() => {
            events.push('work');
            return undefined;
          }),
        );
        entered.resolve();
      }
    }
    @Module({ providers: [Job, Resource] })
    class App {}
    const env = {};
    const app = await createCloudflareApp(App, { env });
    try {
      let done = false;
      const running = dispatch(app, kind, env, {
        waitUntil(promise) {
          native.push(promise);
        },
      }).then(() => {
        done = true;
        return undefined;
      });
      await entered.promise;
      expect(native).toHaveLength(kind === 'queue' ? 1 : 0);
      expect(events).toEqual([]);
      work.resolve();
      await vi.waitFor(() => expect(events).toEqual(['work', 'disposing']));
      expect(done).toBe(false);
      cleanup.resolve();
      await running;
      expect(events).toEqual(['work', 'disposing', 'disposed']);
    } finally {
      work.resolve();
      cleanup.resolve();
      await app.close();
    }
  });

  it.each(kinds)(
    'settles every %s handler and reports handler/deferred failures once',
    async (kind) => {
      const reports: unknown[] = [];
      const failed = new Error('handler failure');
      const deferred = new Error('deferred failure');
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const events: string[] = [];
      @Injectable()
      class Fails {
        @QueueConsumer('jobs')
        @Cron('* * * * *', { dialect: 'cloudflare' })
        run() {
          throw failed;
        }
      }
      @Injectable()
      class Slow {
        constructor(@Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime) {}
        @QueueConsumer('jobs')
        @Cron('* * * * *', { dialect: 'cloudflare' })
        async run() {
          started.resolve();
          await release.promise;
          events.push('finished');
          this.lifetime.defer(() => {
            throw deferred;
          });
        }
      }
      @Module({
        providers: [
          Fails,
          Slow,
          defineProvider(APP_EXCEPTION_HANDLER, {
            useValue: {
              report(error: unknown) {
                reports.push(error);
              },
            },
          }),
        ],
      })
      class App {}
      const env = {};
      const app = await createCloudflareApp(App, { env });
      try {
        let done = false;
        const result = dispatch(app, kind, env).catch((error: unknown) => {
          done = true;
          return error;
        });
        await started.promise;
        await Promise.resolve();
        expect(done).toBe(false);
        release.resolve();
        const error = await result;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([failed, deferred]);
        expect(events).toEqual(['finished']);
        expect(reports).toEqual([failed, deferred]);
      } finally {
        release.resolve();
        await app.close();
      }
    },
  );

  it('does not construct a request-scoped handler rejected by its guard', async () => {
    let constructed = 0;
    class Deny implements CanActivate {
      canActivate() {
        return false;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    @UseGuards(Deny)
    class Job {
      constructor() {
        constructed++;
      }
      @QueueConsumer('jobs') run() {}
    }
    @Module({ providers: [Job] })
    class App {}
    const env = {};
    const app = await createCloudflareApp(App, { env });
    try {
      await expect(dispatch(app, 'queue', env)).rejects.toThrow('Forbidden');
      expect(constructed).toBe(0);
    } finally {
      await app.close();
    }
  });
});

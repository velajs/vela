// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  Cron,
  EXECUTION_LIFETIME,
  REQUEST_CONTEXT,
  Inject,
  InjectEnv,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  UseGuards,
  defineProvider,
  getExecutionLifetime,
  type ExecutionContext,
  type ExecutionLifetime,
  type VelaEnv,
} from '@velajs/vela';
import { createCloudflareApp } from '../../cloudflare-factory';
import { QueueConsumer } from '../../decorators/queue-consumer';

describe('native entrypoint lifetime in workerd', () => {
  it.each(['queue', 'scheduled'] as const)(
    'isolates owners and awaits native I/O before %s disposal',
    async (kind) => {
      const NAME = new InjectionToken<string>('native owner');
      const READY = new InjectionToken<string>('native async factory');
      const prefix = crypto.randomUUID();
      const seen: string[] = [];
      const ids = new Set<string>();
      class Guard {
        async canActivate(context: ExecutionContext) {
          const scope = context.getContainer()!;
          const name = scope.resolve(NAME, context.getModuleId());
          const lifetime = getExecutionLifetime(scope)!;
          expect(lifetime).toBe(scope.resolve(EXECUTION_LIFETIME, context.getModuleId()));
          expect(() => scope.resolve(REQUEST_CONTEXT)).toThrow('inside a request');
          ids.add(lifetime.id);
          seen.push(`guard:${name}`);
          return true;
        }
      }
      @Injectable({ scope: Scope.REQUEST })
      class Resource {
        constructor(
          @Inject(NAME) readonly name: string,
          @InjectEnv() readonly bindings: VelaEnv,
        ) {}
        async dispose() {
          expect(await this.bindings.CACHE.get(`${prefix}:${this.name}`)).toBe('complete');
          seen.push(`disposed:${this.name}`);
        }
      }
      // Queue consumers run their declared guards; a direct scheduled job that
      // declared one would be refused, so only the queue variant declares it.
      @Injectable()
      @(kind === 'queue' ? UseGuards(Guard) : () => {})
      class Job {
        constructor(
          @Inject(READY) readonly ready: string,
          readonly resource: Resource,
          @Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime,
        ) {}
        @QueueConsumer('native-lifetime')
        @Cron('* * * * *', { dialect: 'cloudflare' })
        run(
          _payload: unknown,
          _bindings?: VelaEnv,
          ctx?: { waitUntil(promise: Promise<unknown>): void },
        ) {
          expect(this.ready).toBe(this.resource.name);
          // Queue consumers keep the native context; scheduled jobs receive only
          // their invocation and extend it through EXECUTION_LIFETIME.
          if (kind === 'scheduled') expect(ctx).toBeUndefined();
          ids.add(this.lifetime.id);
          (ctx ?? this.lifetime).waitUntil(
            this.resource.bindings.CACHE.put(`${prefix}:${this.resource.name}`, 'complete'),
          );
          this.lifetime.defer(async () => {
            await this.resource.bindings.FILES.put(`${prefix}:${this.resource.name}`, 'deferred');
            seen.push(`deferred:${this.resource.name}`);
          });
        }
      }
      class Feature {}
      @Module({
        imports: ['one', 'two'].map((key) => ({
          module: Feature,
          key,
          providers: [
            Job,
            Resource,
            defineProvider(NAME, { useValue: key }),
            defineProvider(READY, {
              scope: Scope.REQUEST,
              inject: [NAME],
              useFactory: async (name) => name,
            }),
          ],
        })),
      })
      class App {}
      const app = await createCloudflareApp(App, { env });
      const nativePromises: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(promise: Promise<unknown>) {
          nativePromises.push(promise);
        },
      };
      try {
        if (kind === 'queue') await app.queue({ queue: 'native-lifetime', messages: [] }, env, ctx);
        else await app.scheduled({ cron: '* * * * *' }, env, ctx);
        expect(ids.size).toBe(2);
        expect(nativePromises).toHaveLength(kind === 'queue' ? 2 : 0);
        for (const name of ['one', 'two']) {
          // Declared guards wrap queue consumers only; scheduled jobs run none.
          if (kind === 'queue')
            expect(seen.indexOf(`guard:${name}`)).toBeLessThan(seen.indexOf(`deferred:${name}`));
          else expect(seen).not.toContain(`guard:${name}`);
          expect(seen.indexOf(`deferred:${name}`)).toBeLessThan(seen.indexOf(`disposed:${name}`));
        }
      } finally {
        await app.close();
      }
    },
  );
});

import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ENV,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  defineProvider,
  type VelaEnv,
} from '@velajs/vela';
import { defineWorkflow, WorkflowNonRetryableError } from '@velajs/workflow';
import { z } from 'zod';
import { defineCloudflareApp } from '../index';
import { VelaWorkflowDefinition } from '../workflow-definitions';
import { portableWorkflowStep } from '../workflow/portable-workflow-step';

function isContext(value: object): value is ExecutionContext {
  return 'waitUntil' in value;
}

function platformContext(): ExecutionContext {
  const context = { waitUntil() {}, passThroughOnException() {}, props: {}, exports: {} };
  if (!isContext(context)) throw new Error('Missing context.');
  return context;
}

function event<T>(payload: T): WorkflowEvent<T> {
  return { payload, instanceId: 'example-1', workflowName: 'example', timestamp: new Date(0) };
}

function nativeStep(): WorkflowStep {
  return {
    async do<T>(_name: string, ...rest: unknown[]): Promise<T> {
      const callback = rest.find((value) => typeof value === 'function');
      if (typeof callback !== 'function') throw new Error('Missing callback.');
      return Reflect.apply(callback, undefined, [
        { attempt: 1, config: {}, step: { name: _name, count: 1 } },
      ]);
    },
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => {
      throw new Error('No events in this fake.');
    },
  };
}

const dispatch = async () => 'dispatched';

describe('VelaWorkflowDefinition', () => {
  it('infers a readonly injection tuple, transforms trigger input and disposes per-run providers', async () => {
    const ids: number[] = [];
    const disposed: number[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class PerRun {
      readonly id = ids.push(ids.length + 1);
      dispose() {
        disposed.push(this.id);
      }
    }
    const LABEL = new InjectionToken<string>('label');
    @Module({ providers: [PerRun, defineProvider(LABEL, { useValue: 'accepted' })] })
    class App {}
    const tokens = [PerRun, LABEL] as const;
    const factory = vi.fn();
    const Definition = VelaWorkflowDefinition(defineCloudflareApp(App), {
      params: z.object({ count: z.string().transform(Number) }),
      inject: tokens,
      useFactory: (scope, label) => {
        expectTypeOf(scope).toEqualTypeOf<PerRun>();
        expectTypeOf(label).toEqualTypeOf<string>();
        factory();
        return {
          definition: defineWorkflow<
            { count: number },
            { count: number; label: string; id: number }
          >({
            handler: (ctx) => ({ count: ctx.params.count, label, id: scope.id }),
          }),
          run: dispatch,
        };
      },
    });
    expectTypeOf<Parameters<InstanceType<typeof Definition>['run']>[0]['payload']>().toEqualTypeOf<
      Readonly<{ count: string }>
    >();
    expectTypeOf<Awaited<ReturnType<InstanceType<typeof Definition>['run']>>>().toEqualTypeOf<{
      count: number;
      label: string;
      id: number;
    }>();
    const instance = new Definition(platformContext(), {});
    await expect(instance.run(event({ count: '7' }), nativeStep())).resolves.toEqual({
      count: 7,
      label: 'accepted',
      id: 1,
    });
    await expect(instance.run(event({ count: '8' }), nativeStep())).resolves.toEqual({
      count: 8,
      label: 'accepted',
      id: 2,
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(disposed).toEqual([1, 2]);
  });

  it('rejects invalid params before constructing dependencies or invoking the factory', async () => {
    let constructed = 0,
      singletons = 0,
      factories = 0;
    @Injectable()
    class Singleton {
      constructor() {
        singletons++;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Dependency {
      constructor() {
        constructed++;
      }
    }
    @Module({ providers: [Dependency, Singleton] })
    class App {}
    const Definition = VelaWorkflowDefinition(defineCloudflareApp(App), {
      params: z.object({ count: z.number() }),
      inject: [Dependency, Singleton],
      useFactory: () => {
        factories++;
        return {
          definition: defineWorkflow<{ count: number }, string>({ handler: () => 'ok' }),
          run: dispatch,
        };
      },
    });
    // Simulates unchecked data crossing the native platform boundary.
    const instance = new Definition(platformContext(), {});
    const run: (input: unknown, step: WorkflowStep) => Promise<unknown> = (input, step) =>
      Reflect.apply(instance.run, instance, [input, step]);
    await expect(run(event({ count: 'invalid' }), nativeStep())).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect({ constructed, singletons, factories }).toEqual({
      constructed: 0,
      singletons: 0,
      factories: 0,
    });
    await expect(instance.run(event({ count: 1 }), nativeStep())).resolves.toBe('ok');
    expect({ constructed, singletons, factories }).toEqual({
      constructed: 1,
      singletons: 1,
      factories: 1,
    });
  });

  it('resolves only providers visible to the root and isolates application environments', async () => {
    @Injectable()
    class Binding {
      constructor(@Inject(ENV) readonly env: VelaEnv) {}
    }
    @Module({ providers: [Binding], exports: [Binding] })
    class Feature {}
    @Module({ imports: [Feature] })
    class App {}
    const Definition = VelaWorkflowDefinition(defineCloudflareApp(App), {
      params: z.object({}),
      inject: [Binding],
      useFactory: (binding) => ({
        definition: defineWorkflow({
          handler: (ctx) => ({
            region: Reflect.get(binding.env, 'REGION'),
            same: ctx.env === binding.env,
          }),
        }),
        run: dispatch,
      }),
    });
    await expect(
      new Definition(platformContext(), { REGION: 'one' }).run(event({}), nativeStep()),
    ).resolves.toEqual({ region: 'one', same: true });
    await expect(
      new Definition(platformContext(), { REGION: 'two' }).run(event({}), nativeStep()),
    ).resolves.toEqual({ region: 'two', same: true });

    @Module({ providers: [Binding] })
    class PrivateFeature {}
    @Module({ imports: [PrivateFeature] })
    class PrivateApp {}
    const Private = VelaWorkflowDefinition(defineCloudflareApp(PrivateApp), {
      params: z.object({}),
      inject: [Binding],
      useFactory: () => ({
        definition: defineWorkflow<Record<string, never>, number>({ handler: () => 1 }),
        run: dispatch,
      }),
    });
    await expect(new Private(platformContext(), {}).run(event({}), nativeStep())).rejects.toThrow();
  });

  it('translates terminal handler errors and preserves ordinary errors and engine interruption', async () => {
    @Module({})
    class App {}
    const failure = new InjectionToken<{ error: Error }>('failure');
    const errors = [
      new WorkflowNonRetryableError('terminal'),
      new Error('ordinary'),
      new Error('Aborting engine: paused'),
    ];
    for (const error of errors) {
      const app = defineCloudflareApp({
        module: App,
        providers: [defineProvider(failure, { useValue: { error } })],
      });
      const Definition = VelaWorkflowDefinition(app, {
        params: z.object({}),
        inject: [failure],
        useFactory: ({ error: failure }) => ({
          definition: defineWorkflow({
            handler: () => {
              throw failure;
            },
          }),
          run: dispatch,
        }),
      });
      const result = new Definition(platformContext(), {}).run(event({}), nativeStep());
      if (error instanceof WorkflowNonRetryableError)
        await expect(result).rejects.toBeInstanceOf(NonRetryableError);
      else await expect(result).rejects.toBe(error);
    }
  });
});

describe('portable native steps', () => {
  it('converts callback and rollback terminal errors before native retry decisions', async () => {
    let observed: unknown;
    const native = nativeStep();
    native.do = async <T>(_name: string, ...args: unknown[]): Promise<T> => {
      const callback = args.find((value) => typeof value === 'function');
      const rollback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Missing callback.');
      try {
        await Reflect.apply(callback, undefined, [
          { attempt: 1, config: {}, step: { name: _name, count: 1 } },
        ]);
      } catch (error) {
        observed = error;
      }
      if (
        rollback &&
        typeof rollback === 'object' &&
        'rollback' in rollback &&
        typeof rollback.rollback === 'function'
      )
        return Reflect.apply(rollback.rollback, undefined, [
          {
            ctx: { attempt: 1, config: {}, step: { name: _name, count: 1 } },
            error: new Error('undo'),
            output: undefined,
            stepName: _name,
          },
        ]);
      throw observed;
    };
    const steps = portableWorkflowStep(native);
    await expect(
      steps.do(
        'terminal',
        async () => {
          throw new WorkflowNonRetryableError('forward');
        },
        {
          rollback: async () => {
            throw new WorkflowNonRetryableError('rollback');
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'NonRetryableError', message: 'rollback' });
    expect(observed).toBeInstanceOf(NonRetryableError);
  });

  it('forwards retry counts, supports native default delay and rejects malformed durations', async () => {
    let seen: unknown;
    const native = nativeStep();
    const original = native.do.bind(native);
    native.do = <T>(name: string, ...args: unknown[]): Promise<T> => {
      seen = args[0];
      return Reflect.apply(original, native, [name, ...args]);
    };
    const steps = portableWorkflowStep(native);
    await expect(steps.do('count', { retries: { limit: 2 } }, async () => 3)).resolves.toBe(3);
    expect(seen).toEqual({ retries: { limit: 2, delay: 10_000 } });
    expect(() => steps.sleep('bad', 'eventually')).toThrow(NonRetryableError);
  });
});

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '../index';
import type { StandardSchemaV1 } from '../validation/index';
import {
  defineQueueJob,
  dispatchQueueJob,
  inline,
  Process,
  Processor,
  QueueClient,
  QueueModule,
  queueToken,
} from '../queue';
import type { QueueJob, QueueJobOutput } from '../queue';

const numeric: StandardSchemaV1<{ count: string }, { count: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('count' in value) ||
        typeof value.count !== 'string'
      ) {
        return { issues: [{ message: 'count must be a string' }] };
      }
      return { value: { count: Number(value.count) } };
    },
  },
};
const count = defineQueueJob('count', numeric);

describe('validated queue contracts', () => {
  it('keeps wire input across transport and parses output at the processor', async () => {
    const seen: number[] = [];
    @Processor('jobs')
    class Consumer {
      @Process(count) handle(job: QueueJob<QueueJobOutput<typeof count>>) {
        seen.push(job.data.count);
      }
    }
    const driver = inline({ mode: 'manual' });
    @Module({
      imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'jobs' })],
      providers: [Consumer],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const input = { count: '12' };
    const accepted = app.get(queueToken('jobs')).add(count, input);
    input.count = '99';
    expect((await accepted).data).toEqual({ count: '12' });
    await driver.flush();
    expect(seen).toEqual([12]);
    await expect(
      dispatchQueueJob(app.getContainer(), app.entrypoints, {
        id: 'external',
        queue: 'jobs',
        name: 'count',
        data: { count: 12 },
        attempt: 2,
      }),
    ).rejects.toThrow('Validation failed');
    expect(seen).toEqual([12]);
    await app.close();
  });

  it('rejects invalid data before driver acceptance and preserves validator failures', async () => {
    let sends = 0;
    const client = new QueueClient('jobs', {
      kind: 'test',
      async enqueue() {
        sends++;
      },
    });
    const invalid = defineQueueJob('invalid', {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'invalid' }] }),
      },
    });
    await expect(client.add(invalid, null)).rejects.toThrow('Validation failed');
    const broken = defineQueueJob('broken', {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('validator defect');
        },
      },
    });
    await expect(client.add(broken, null)).rejects.toThrow('validator defect');
    expect(sends).toBe(0);
  });

  it('waits for every processor before surfacing failure and supports strict unmatched routing', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    @Processor('jobs')
    class Broken {
      @Process() run() {
        throw new Error('failed');
      }
    }
    @Processor('jobs')
    class Slow {
      @Process() async run() {
        await barrier;
        finished = true;
      }
    }
    @Module({ providers: [Broken, Slow] })
    class App {}
    const app = await VelaFactory.create(App);
    const job = { id: 'j', queue: 'jobs', name: 'n', data: {}, attempt: 1 };
    let settled = false;
    const delivery = dispatchQueueJob(app.getContainer(), app.entrypoints, job).catch(
      (e: unknown) => {
        settled = true;
        throw e;
      },
    );
    const rejection = expect(delivery).rejects.toThrow('failed');
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejection;
    expect(finished).toBe(true);
    await expect(
      dispatchQueueJob(
        app.getContainer(),
        app.entrypoints,
        { ...job, queue: 'missing' },
        { unhandled: 'error' },
      ),
    ).rejects.toThrow('No processor');
    // A transport acknowledges when delivery resolves, so an unhandled job
    // rejects unless the caller explicitly ignores it.
    await expect(
      dispatchQueueJob(app.getContainer(), app.entrypoints, { ...job, queue: 'missing' }),
    ).rejects.toThrow('No processor');
    await expect(
      dispatchQueueJob(
        app.getContainer(),
        app.entrypoints,
        { ...job, queue: 'missing' },
        { unhandled: 'ignore' },
      ),
    ).resolves.toEqual({ handled: 0 });
    await app.close();
  });
});

it('runs an async Zod transform once per producer and consumer boundary', async () => {
  let calls = 0;
  const definition = defineQueueJob(
    'async-transform',
    z.string().transform(async (wire) => {
      calls++;
      await Promise.resolve();
      return Number(wire);
    }),
  );
  const seen: number[] = [];
  @Processor('transform')
  class Consumer {
    @Process(definition) handle(job: QueueJob<QueueJobOutput<typeof definition>>) {
      seen.push(job.data);
    }
  }
  const driver = inline({ mode: 'manual' });
  @Module({
    imports: [QueueModule.forRoot({ driver }), QueueModule.registerQueue({ name: 'transform' })],
    providers: [Consumer],
  })
  class App {}
  const app = await VelaFactory.create(App);
  const accepted = await app.get(queueToken('transform')).add(definition, '12');
  expect(calls).toBe(1);
  expect(accepted.data).toBe('12');
  await driver.flush();
  expect(calls).toBe(2);
  expect(seen).toEqual([12]);
  await app.close();
});

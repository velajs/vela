import { describe, expect, it } from 'vitest';
import { Inject, Injectable, Module, VelaFactory } from '../index';
import { inline, Process, Processor, QueueClient, QueueModule, queueToken } from '../queue';
import type { InlineQueueDriver } from '../queue';

describe('queue driver application ownership', () => {
  it('rejects rebinding without rerouting buffered jobs', async () => {
    const driver = inline({ mode: 'manual' });
    const seen: string[] = [];
    driver.bind!(async () => {
      seen.push('first');
    });
    await driver.enqueue({ id: 'one', queue: 'q', name: 'n', data: {}, attempt: 1 });
    expect(() =>
      driver.bind!(async () => {
        seen.push('second');
      }),
    ).toThrow(/already belongs/);
    await driver.flush();
    expect(seen).toEqual(['first']);
  });

  it('creates isolated drivers from one reusable module declaration and disposes bindings', async () => {
    const drivers: InlineQueueDriver[] = [];
    const seen: string[] = [];
    @Injectable()
    class Producer {
      constructor(@Inject(queueToken('owned')) readonly queue: QueueClient) {}
    }
    @Processor('owned')
    class Consumer {
      @Process() handle(job: { data: string }) {
        seen.push(job.data);
      }
    }
    @Module({
      imports: [
        QueueModule.forRoot({
          driver: () => {
            const driver = inline({ mode: 'manual' });
            drivers.push(driver);
            return driver;
          },
        }),
        QueueModule.forFeature([{ name: 'owned' }]),
      ],
      providers: [Producer, Consumer],
    })
    class App {}
    const a = await VelaFactory.create(App);
    const b = await VelaFactory.create(App);
    await a.get(Producer).queue.add('n', 'A');
    await b.get(Producer).queue.add('n', 'B');
    expect(drivers).toHaveLength(2);
    await drivers[0]!.flush();
    expect(seen).toEqual(['A']);
    await a.close();
    await b.get(Producer).queue.add('n', 'B2');
    await drivers[1]!.flush();
    expect(seen).toEqual(['A', 'B', 'B2']);
    expect(drivers[0]!.size).toBe(0);
    expect(() => drivers[0]!.bind!(async () => {})).toThrow(/already belongs/);
    await b.close();
  });

  it('rejects sharing a custom bound driver between applications', async () => {
    const shared = { kind: 'test', enqueue: async () => {}, bind: () => () => {} };
    @Injectable()
    class Producer {
      constructor(@Inject(queueToken('shared')) readonly queue: QueueClient) {}
    }
    @Module({
      imports: [
        QueueModule.forRoot({ driver: shared }),
        QueueModule.forFeature([{ name: 'shared' }]),
      ],
      providers: [Producer],
    })
    class App {}
    const first = await VelaFactory.create(App);
    await expect(VelaFactory.create(App)).rejects.toThrow(/already belongs/);
    await first.close();
  });
});

it('does not silently deduplicate different driver instances with the same kind', async () => {
  const a = inline({ mode: 'manual' });
  const b = inline({ mode: 'manual' });
  @Module({
    imports: [
      QueueModule.forRoot({ driver: a }),
      QueueModule.forRoot({ driver: b }),
      QueueModule.forFeature([{ name: 'collision' }]),
    ],
  })
  class App {}
  await expect(VelaFactory.create(App)).rejects.toThrow(/imported with different options/);
});

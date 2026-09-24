import {
  defineProvider,
  type DynamicModule,
  InjectionToken,
  Module,
  VelaFactory,
} from '@velajs/vela';
import {
  dispatchQueueJob,
  inline,
  QueueModule,
  QueueRegistry,
  type QueueDriver,
  type QueueJob,
} from '@velajs/vela/queue';
import { afterEach, describe, expect, it } from 'vitest';
import { MailError } from '../mail.error';
import { MailModule } from '../mail.module';
import { MailService } from '../mail.service';
import { MAIL_OPTIONS, MAIL_TRANSPORT, MAIL_QUEUE_JOB } from '../mail.tokens';
import type { MailInboundGate } from '../inbound/gate';
import type {
  BuiltMessage,
  DeliveryResult,
  MailMessage,
  MailTransport,
  RenderSeam,
} from '../types';
import { ADDRESS_VECTORS, CONTROL_VECTORS } from './vectors';

const FROM = 'sender@example.com';

interface SpyTransport extends MailTransport {
  readonly calls: BuiltMessage[];
}

function spyTransport(): SpyTransport {
  const calls: BuiltMessage[] = [];
  return {
    calls,
    async deliver(message: BuiltMessage): Promise<DeliveryResult> {
      calls.push(message);
      return { id: `spy-${calls.length}`, provider: 'spy' };
    },
  };
}

function validMessage(): MailMessage {
  return { to: 'a@b.com', cc: 'c@d.com', subject: 'Hi', text: 'body', headers: { 'X-Tag': 'ok' } };
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
});

async function makeApp(transport: SpyTransport, withQueue: boolean) {
  const driver = inline({ mode: 'manual' });
  const mailModule = withQueue
    ? MailModule.forRoot({ from: FROM, transport, queue: { name: 'mail' } })
    : MailModule.forRoot({ from: FROM, transport });

  @Module({
    // The mailer registers its own queue; the application only picks the driver.
    imports: [QueueModule.forRoot({ driver }), mailModule],
  })
  class App {}

  const app = await VelaFactory.create(App);
  disposers.push(() => app.dispose());
  return { app, driver };
}

describe('MailModule + MailService', () => {
  describe('security-sensitive module identity', () => {
    it('dedups the same references and reports equal-shaped transport and render instances', async () => {
      const transport = spyTransport();
      const render: RenderSeam = async () => ({ text: 'rendered' });
      const first = MailModule.forRoot({ from: FROM, transport, render });
      const repeat = MailModule.forRoot({ from: FROM, transport, render });
      expect(repeat.key).toBe(first.key);

      @Module({ imports: [first, repeat] })
      class Same {}
      const same = await VelaFactory.create(Same, { diagnostics: 'throw' });
      disposers.push(() => same.dispose());
      expect(same.getContainer().getOwnerModuleIds(MAIL_OPTIONS)).toHaveLength(1);

      // Another transport under the same key is a conflicting configuration,
      // never merged into the first mailer.
      const otherTransport = MailModule.forRoot({ from: FROM, transport: spyTransport(), render });
      @Module({ imports: [first, otherTransport] })
      class Conflicting {}
      await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
        /MailModule#\w+ was imported again with different options/,
      );

      const makeRender = (): RenderSeam => async () => ({ text: 'rendered' });
      @Module({
        imports: [
          MailModule.forRoot({ from: FROM, transport, render: makeRender() }),
          MailModule.forRoot({ from: FROM, transport, render: makeRender() }),
        ],
      })
      class SameSourceRenders {}
      await expect(VelaFactory.create(SameSourceRenders, { diagnostics: 'throw' })).rejects.toThrow(
        /was imported again with different options/,
      );

      // Two mailers coexist under their own keys.
      @Module({ imports: [first, { ...otherTransport, key: 'secondary' }] })
      class TwoMailers {}
      const two = await VelaFactory.create(TwoMailers, { diagnostics: 'throw' });
      disposers.push(() => two.dispose());
      expect(two.getContainer().getOwnerModuleIds(MAIL_OPTIONS)).toHaveLength(2);
    });

    it('gives each inbound gate object its own global host', () => {
      const sharedPolicy = () => true;
      const makeGate = (): MailInboundGate => ({
        require: ['dmarc'],
        policy: sharedPolicy,
      });
      const firstGate = makeGate();
      const secondGate = makeGate();
      const hostKey = (module: DynamicModule) =>
        (module.imports?.[0] as DynamicModule | undefined)?.key;
      const first = MailModule.forRoot({ from: FROM, inbound: { gate: firstGate } });
      const repeat = MailModule.forRoot({ from: FROM, inbound: { gate: firstGate } });
      const second = MailModule.forRoot({ from: FROM, inbound: { gate: secondGate } });

      expect(hostKey(repeat)).toBe(hostKey(first));
      expect(hostKey(second)).not.toBe(hostKey(first));

      const makePolicy = () => () => true;
      const mutableGate: MailInboundGate = { require: ['dmarc'], policy: makePolicy() };
      const beforePolicyChange = MailModule.forRoot({
        from: FROM,
        inbound: { gate: mutableGate },
      });
      mutableGate.policy = makePolicy();
      const afterPolicyChange = MailModule.forRoot({
        from: FROM,
        inbound: { gate: mutableGate },
      });
      expect(hostKey(afterPolicyChange)).not.toBe(hostKey(beforePolicyChange));
    });

    it('reports same-source async closures and keeps async wiring functional', async () => {
      const makeFactory = (transport: MailTransport) => () => ({ from: FROM, transport });
      const firstTransport = spyTransport();
      const first = MailModule.forRootAsync({
        useFactory: makeFactory(firstTransport),
      });
      const second = MailModule.forRootAsync({
        useFactory: makeFactory(spyTransport()),
      });
      expect(second.key).toBe(first.key);

      @Module({ imports: [first, second] })
      class Conflicting {}
      await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
        /MailModule#\w+ was imported again with different options/,
      );

      @Module({ imports: [first] })
      class App {}

      const app = await VelaFactory.create(App);
      disposers.push(() => app.dispose());
      await app.get(MailService).send(validMessage());
      expect(firstTransport.calls).toHaveLength(1);
    });

    it('rejects an async factory that declares parameters but no inject', () => {
      expect(() =>
        // @ts-expect-error A factory with parameters names the tokens that supply them.
        MailModule.forRootAsync({ useFactory: (from: string) => ({ from }) }),
      ).toThrow(/MailModule\.forRootAsync: useFactory declares parameters but no inject tokens/);
    });

    it('reports one async factory wired to distinct equal-named configuration tokens', async () => {
      interface MailConfig {
        transport: MailTransport;
      }
      const firstConfig = new InjectionToken<MailConfig>('MAIL_CONFIG');
      const secondConfig = new InjectionToken<MailConfig>('MAIL_CONFIG');
      const useFactory = (config: MailConfig) => ({ from: FROM, transport: config.transport });

      const first = MailModule.forRootAsync({ inject: [firstConfig], useFactory });
      const second = MailModule.forRootAsync({ inject: [secondConfig], useFactory });
      @Module({ imports: [first, second] })
      class Conflicting {}
      await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
        /was imported again with different options/,
      );
    });

    it('reports registrations with the same label but distinct configuration', async () => {
      const key = 'mail-security-explicit-conflict';
      const first = MailModule.forRoot({ from: FROM, transport: spyTransport(), key });
      const second = MailModule.forRoot({ from: FROM, transport: spyTransport(), key });
      expect(second.key).toBe(first.key);
      @Module({ imports: [first, second] })
      class Conflicting {}
      await expect(VelaFactory.create(Conflicting, { diagnostics: 'throw' })).rejects.toThrow(
        `MailModule#${key} was imported again with different options`,
      );
    });
  });

  it('forRoot provides a MailService that delivers through the transport', async () => {
    const transport = spyTransport();
    const { app } = await makeApp(transport, false);
    const svc = app.get(MailService);

    const result = await svc.send(validMessage());
    expect(result.provider).toBe('spy');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.subject).toBe('Hi');
    expect(transport.calls[0]!.envelope.to).toEqual(['a@b.com', 'c@d.com']);
  });

  it('throws no_transport when no transport is configured', async () => {
    @Module({ imports: [MailModule.forRoot({ from: FROM })] })
    class App {}
    const app = await VelaFactory.create(App);
    disposers.push(() => app.dispose());
    const svc = app.get(MailService);

    let code: string | undefined;
    try {
      await svc.send(validMessage());
    } catch (err) {
      if (err instanceof MailError) code = err.code;
    }
    expect(code).toBe('no_transport');
  });

  it('resolves a transport supplied via a global MAIL_TRANSPORT token (no explicit transport)', async () => {
    const transport = spyTransport();

    // A transport module (e.g. the Cloudflare send-email adapter) contributes
    // MAIL_TRANSPORT as a GLOBAL provider — the `global: true` pattern MailModule
    // itself uses for the inbound gate — so MailService resolves it without an
    // explicit `transport` option.
    class TransportHost {}
    const transportModule: DynamicModule = {
      module: TransportHost,
      providers: [defineProvider(MAIL_TRANSPORT, { useValue: transport })],
      exports: [MAIL_TRANSPORT],
      global: true,
    };

    @Module({ imports: [transportModule, MailModule.forRoot({ from: FROM })] })
    class App {}
    const app = await VelaFactory.create(App);
    disposers.push(() => app.dispose());

    await app.get(MailService).send(validMessage());
    expect(transport.calls).toHaveLength(1);
  });

  describe('outbound injection matrix — guards run ABOVE the transport seam', () => {
    it('rejects every field × vector before transport.deliver is called', async () => {
      const transport = spyTransport();
      const { app } = await makeApp(transport, false);
      const svc = app.get(MailService);

      const attempts: Array<{ label: string; msg: MailMessage; code: string }> = [];

      for (const { label, char } of ADDRESS_VECTORS) {
        const bad = `bad${char}@evil.com`;
        attempts.push(
          {
            label: `from/${label}`,
            msg: { ...validMessage(), from: bad },
            code: 'invalid_address',
          },
          { label: `to/${label}`, msg: { ...validMessage(), to: bad }, code: 'invalid_address' },
          { label: `cc/${label}`, msg: { ...validMessage(), cc: bad }, code: 'invalid_address' },
          { label: `bcc/${label}`, msg: { ...validMessage(), bcc: bad }, code: 'invalid_address' },
          {
            label: `replyTo/${label}`,
            msg: { ...validMessage(), replyTo: bad },
            code: 'invalid_address',
          },
        );
      }
      for (const { label, char } of CONTROL_VECTORS) {
        attempts.push(
          {
            label: `subject/${label}`,
            msg: { ...validMessage(), subject: `Hi${char}x` },
            code: 'invalid_header',
          },
          {
            label: `headerValue/${label}`,
            msg: { ...validMessage(), headers: { 'X-Tag': `a${char}b` } },
            code: 'invalid_header',
          },
          {
            label: `headerName/${label}`,
            msg: { ...validMessage(), headers: { [`X-${char}`]: 'v' } },
            code: 'invalid_header',
          },
        );
      }

      for (const attempt of attempts) {
        let code: string | undefined;
        try {
          await svc.send(attempt.msg);
        } catch (err) {
          if (err instanceof MailError) code = err.code;
          else throw err;
        }
        expect(code, `expected ${attempt.label} to throw`).toBe(attempt.code);
      }

      // The whole point: not a single poisoned message reached the transport.
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe('queue path', () => {
    it('queue() builds+guards then enqueues; the consumer re-validates and delivers', async () => {
      const transport = spyTransport();
      const { app, driver } = await makeApp(transport, true);
      const svc = app.get(MailService);

      const outcome = await svc.queue(validMessage());
      expect(outcome).toEqual({ queued: true });
      expect(transport.calls).toHaveLength(0); // not delivered until the consumer runs

      const delivered = await driver.flush();
      expect(delivered).toBe(1);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.subject).toBe('Hi');
    });

    it('queue() runs guards BEFORE enqueue (a poisoned message is never buffered)', async () => {
      const transport = spyTransport();
      const { app, driver } = await makeApp(transport, true);
      const svc = app.get(MailService);

      let code: string | undefined;
      try {
        await svc.queue({ ...validMessage(), subject: 'evil\r\ninjected' });
      } catch (err) {
        if (err instanceof MailError) code = err.code;
      }
      expect(code).toBe('invalid_header');
      expect(driver.size).toBe(0); // nothing was buffered
      await driver.flush();
      expect(transport.calls).toHaveLength(0);
    });

    it('the consumer rejects a poisoned dequeued wire (guards run a SECOND time)', async () => {
      const transport = spyTransport();
      const { app } = await makeApp(transport, true);

      const base = await import('../build').then((m) =>
        m.buildMessage(validMessage(), { from: FROM }),
      );
      // Simulate a compromised producer/queue landing arbitrary JSON.
      const poisoned: QueueJob = {
        id: 'job-1',
        queue: 'mail',
        name: MAIL_QUEUE_JOB,
        data: { ...base, subject: 'evil\r\ninjected' },
        attempt: 1,
      };

      await expect(
        dispatchQueueJob(app.getContainer(), app.entrypoints, poisoned),
      ).rejects.toBeInstanceOf(MailError);
      expect(transport.calls).toHaveLength(0);
    });

    it('registers its queue with the binding and consumer pin it is given', async () => {
      const sent: QueueJob[] = [];
      const driver: QueueDriver = {
        kind: 'recording',
        async enqueue(job) {
          sent.push(job);
        },
      };
      @Module({
        imports: [
          QueueModule.forRoot({ driver }),
          MailModule.forRoot({
            from: FROM,
            transport: spyTransport(),
            queue: { name: 'outbound', binding: 'MAIL_QUEUE', consumer: 'mail-production' },
          }),
        ],
      })
      class App {}
      const app = await VelaFactory.create(App);
      disposers.push(() => app.dispose());
      expect(app.get(QueueRegistry).get('outbound')).toEqual({
        name: 'outbound',
        binding: 'MAIL_QUEUE',
        consumers: ['mail-production'],
      });
      await app.get(MailService).queue(validMessage());
      expect(sent.map((job) => [job.queue, job.name])).toEqual([['outbound', MAIL_QUEUE_JOB]]);
    });

    it('requires QueueModule.forRoot at bootstrap when a queue is configured', async () => {
      @Module({ imports: [MailModule.forRoot({ from: FROM, queue: {} })] })
      class App {}
      await expect(VelaFactory.create(App)).rejects.toThrow(/QueueModule\.forRoot/);
    });

    it('throws queue_required when no queue is configured', async () => {
      const transport = spyTransport();
      const { app } = await makeApp(transport, false);
      const svc = app.get(MailService);

      let error: MailError | undefined;
      try {
        await svc.queue(validMessage());
      } catch (err) {
        if (err instanceof MailError) error = err;
      }
      expect(error?.code).toBe('queue_required');
      // The fix is MailModule configuration, not a hand-registered queue.
      expect(error?.message).toMatch(/queue: \{ name\?, binding\? \}.*MailModule\.forRoot/);
      expect(error?.message).toMatch(
        /QueueModule\.forRoot\(\{ driver \}\) once in the root module/,
      );
    });
  });
});

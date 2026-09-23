import {
  defineProvider,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  UseGuards,
  VelaFactory,
  type CanActivate,
  type ExecutionContext,
  type DynamicModule,
} from '@velajs/vela';
import { inline, QueueModule } from '@velajs/vela/queue';
import { afterEach, describe, expect, it } from 'vitest';
import { MailModule } from '../mail.module';
import { MailService } from '../mail.service';
import { MAIL_OPTIONS } from '../mail.tokens';
import { OnInboundEmail } from '../inbound/decorator';
import { dispatchInboundEmail } from '../inbound/dispatch';
import { parseInboundEmail } from '../inbound/parse';
import { createMailCatcher } from '../transports/catcher';
import { buildMessage } from '../build';
import { reparseBuiltWire } from '../wire';
import { evaluateInboundGate, type MailInboundGate } from '../inbound/gate';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const raw = 'From: sender@example.com\r\nTo: support@example.com\r\n\r\nHelp';
const email = () =>
  parseInboundEmail(raw, {
    verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
  });
const message = { to: 'a@example.com', subject: 'hello', text: 'body' };
async function appWith(imports: DynamicModule[]) {
  @Module({ imports })
  class App {}
  const app = await VelaFactory.create(App);
  cleanup.push(() => app.dispose());
  return app;
}

describe('inbound module ownership and lifetime', () => {
  it('resolves the same handler and guard in each owning module, with a fresh disposed scope', async () => {
    const Tenant = new InjectionToken<string>('tenant');
    const seen: string[] = [];
    const disposed: string[] = [];
    let sequence = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      readonly id = ++sequence;
      constructor(@Inject(Tenant) readonly tenant: string) {}
      dispose() {
        disposed.push(`${this.tenant}:${this.id}`);
      }
    }
    @Injectable()
    class Guard implements CanActivate {
      constructor(@Inject(Resource) readonly resource: Resource) {}
      canActivate(context: ExecutionContext) {
        expect(context.getContainer()?.resolve(Resource, context.getModuleId())).toBe(
          this.resource,
        );
        seen.push(`guard:${this.resource.tenant}:${this.resource.id}`);
        return true;
      }
    }
    @Injectable()
    @UseGuards(Guard)
    class Inbox {
      constructor(@Inject(Resource) readonly resource: Resource) {}
      @OnInboundEmail()
      handle() {
        seen.push(`handler:${this.resource.tenant}:${this.resource.id}`);
      }
    }
    class Feature {}
    const app = await appWith(
      ['alpha', 'beta'].map((tenant) => ({
        module: Feature,
        key: tenant,
        providers: [Inbox, Guard, Resource, defineProvider(Tenant, { useValue: tenant })],
      })),
    );
    expect(sequence).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(await dispatchInboundEmail(app.getContainer(), app.entrypoints, email())).toEqual({
        gated: false,
        handled: 2,
        failed: [],
      });
    }
    expect(sequence).toBe(4);
    expect(disposed).toHaveLength(4);
    for (const resource of disposed) {
      expect(seen).toContain(`guard:${resource}`);
      expect(seen).toContain(`handler:${resource}`);
    }
  });

  it('materializes lazy async dependencies and disposes a failed invocation', async () => {
    const Config = new InjectionToken<string>('async-inbound-config');
    let created = 0;
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Inbox {
      constructor(@Inject(Config) readonly config: string) {
        created++;
      }
      @OnInboundEmail()
      handle() {
        expect(this.config).toBe('ready');
        throw new Error('delivery failed');
      }
      dispose() {
        disposed++;
      }
    }
    class Feature {}
    const app = await appWith([
      {
        module: Feature,
        lazy: true,
        providers: [Inbox, defineProvider(Config, { useFactory: async () => 'ready' })],
      },
    ]);
    expect(created).toBe(0);
    await expect(
      dispatchInboundEmail(app.getContainer(), app.entrypoints, email()),
    ).rejects.toThrow('delivery failed');
    expect(created).toBe(1);
    expect(disposed).toBe(1);
  });

  it('waits for other handlers and their disposal before surfacing a failure', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposed = false;
    @Injectable()
    class Failed {
      @OnInboundEmail() handle() {
        throw new Error('failed');
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Pending {
      @OnInboundEmail() async handle() {
        await waiting;
      }
      dispose() {
        disposed = true;
      }
    }
    class Feature {}
    const app = await appWith([{ module: Feature, providers: [Failed, Pending] }]);
    let settled = false;
    const dispatch = dispatchInboundEmail(app.getContainer(), app.entrypoints, email()).catch(
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    const rejection = expect(dispatch).rejects.toThrow('failed');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    await rejection;
    expect(disposed).toBe(true);
  });
});

describe('application isolation and queue routing', () => {
  it('allows independent apps to reuse an explicit key without sharing transport, queue or gate', async () => {
    const instances = [];
    for (const allowed of [true, false]) {
      const catcher = createMailCatcher();
      const driver = inline({ mode: 'manual' });
      const app = await appWith([
        QueueModule.forRoot({ driver }),
        MailModule.forRoot({
          key: 'default',
          from: 'sender@example.com',
          transport: catcher,
          queue: {},
          inbound: { gate: { policy: () => allowed } },
        }),
      ]);
      instances.push({ app, catcher, driver, allowed });
    }
    for (const { app, catcher, driver, allowed } of instances) {
      await app.get(MailService).queue(message);
      await driver.flush();
      expect(catcher.messages()).toHaveLength(1);
      expect((await dispatchInboundEmail(app.getContainer(), app.entrypoints, email())).gated).toBe(
        !allowed,
      );
    }
    expect(instances[0]!.catcher.messages()).toHaveLength(1);
  });

  it('routes distinct queues to their own mail configuration', async () => {
    const alpha = createMailCatcher();
    const beta = createMailCatcher();
    const driver = inline({ mode: 'manual' });
    const app = await appWith([
      QueueModule.forRoot({ driver }),
      ...[alpha, beta].map((catcher, i) =>
        MailModule.forRoot({
          from: 'sender@example.com',
          transport: catcher,
          queue: { name: i === 0 ? 'alpha' : 'beta' },
        }),
      ),
    ]);
    const owners = app.getContainer().getOwnerModuleIds(MAIL_OPTIONS);
    for (const owner of owners) await app.getContainer().resolve(MailService, owner).queue(message);
    await driver.flush();
    expect(alpha.messages()).toHaveLength(1);
    expect(beta.messages()).toHaveLength(1);
  });

  it('rejects two mail registrations consuming the same queue', async () => {
    await expect(
      appWith([
        QueueModule.forRoot(),
        ...[1, 2].map(() =>
          MailModule.forRoot({
            from: 'sender@example.com',
            queue: {},
            transport: createMailCatcher(),
          }),
        ),
      ]),
    ).rejects.toThrow('belongs to multiple mail registrations');
  });

  it('rejects conflicting queues before application lifecycle hooks can send', async () => {
    const catcher = createMailCatcher();
    let started = false;
    const first = MailModule.forRoot({ from: 'sender@example.com', queue: {}, transport: catcher });
    const second = MailModule.forRoot({ from: 'other@example.com', queue: {}, transport: catcher });
    @Injectable()
    class Startup {
      constructor(@Inject(MailService) readonly mailer: MailService) {}
      async onModuleInit() {
        started = true;
        await this.mailer.send(message);
      }
    }
    class Feature {}
    await expect(
      appWith([
        QueueModule.forRoot(),
        { module: Feature, imports: [first], providers: [Startup] },
        second,
      ]),
    ).rejects.toThrow('belongs to multiple mail registrations');
    expect(started).toBe(false);
    expect(catcher.messages()).toHaveLength(0);
  });

  it('rejects factory-supplied structural configuration', async () => {
    await expect(
      appWith([
        MailModule.forRootAsync({
          useFactory: () => ({
            from: 'sender@example.com',
            queue: { name: 'hidden' },
          }),
        }),
      ]),
    ).rejects.toThrow('must be structural options');
  });
});

describe('authentication and wire boundaries', () => {
  it('rejects empty authentication requirements even with a permissive policy', () => {
    expect(() =>
      evaluateInboundGate({ require: [], policy: () => true }, email().authentication, email()),
    ).toThrow('at least one valid authentication mechanism');
  });

  it('snapshots a registered gate before its caller mutates it', async () => {
    const gate: MailInboundGate = { require: ['spf'] };
    const registration = MailModule.forRoot({ from: 'a@example.com', inbound: { gate } });
    gate.require!.splice(0, 1, 'dmarc');
    const app = await appWith([registration]);
    const incoming = email();
    incoming.authentication.spf = 'fail';
    expect(
      (await dispatchInboundEmail(app.getContainer(), app.entrypoints, incoming)).failed,
    ).toEqual(['spf']);
  });

  it('rejects array records and malformed optional queue address fields', async () => {
    const built = await buildMessage(message, { from: 'sender@example.com' });
    for (const data of [
      [],
      { ...built, headers: [] },
      { ...built, from: { email: 'a@example.com', name: 123 } },
    ]) {
      expect(() => reparseBuiltWire(data)).toThrow();
    }
    const hostile = { ...built, envelope: { from: 'evil@example.com', to: ['evil@example.com'] } };
    expect(reparseBuiltWire(hostile).envelope).toEqual(built.envelope);
  });

  it('copies inbound bytes and SMTP envelope and validates envelope headers', () => {
    const bytes = new TextEncoder().encode(raw);
    const envelope = { from: 'sender@example.com', to: 'support@example.com' };
    const parsed = parseInboundEmail(bytes.buffer, { envelope });
    bytes.fill(0);
    envelope.to = 'changed@example.com';
    expect(parsed.rawText()).toBe(raw);
    expect(parsed.envelope?.to).toBe('support@example.com');
    expect(() =>
      parseInboundEmail(raw, { envelope: { from: 'a\r\nb', to: 'c@example.com' } }),
    ).toThrow();
  });
});

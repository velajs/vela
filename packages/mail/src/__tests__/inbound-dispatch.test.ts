import {
  APP_EXCEPTION_HANDLER,
  defineProvider,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  type ExecutionContext,
  Injectable,
  MetadataRegistry,
  Module,
  type NestInterceptor,
  type ProviderDefinition,
  Scope,
  type Type,
  UseFilters,
  UseGuards,
  UseInterceptors,
  VelaFactory,
} from '@velajs/vela';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OnInboundEmail } from '../inbound/decorator';
import { dispatchInboundEmail } from '../inbound/dispatch';
import { parseInboundEmail, type InboundEmail } from '../inbound/parse';
import { MailModule } from '../mail.module';
import { MAIL_INBOUND_GATE } from '../mail.tokens';
import type { MailInboundGate } from '../inbound/gate';

beforeEach(() => MetadataRegistry.clear());

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
});

function emailWith(dmarc: string, extraHeaders: string[] = []): InboundEmail {
  const lines = [
    `Authentication-Results: mx.example.com; dkim=pass; spf=pass; dmarc=${dmarc}`,
    'From: sender@example.com',
    'To: support@example.com',
    'Subject: Help',
    ...extraHeaders,
  ];
  return parseInboundEmail(`${lines.join('\r\n')}\r\n\r\nbody`, {
    envelope: { from: 'sender@example.com', to: 'support@example.com' },
    trustedAuthservIds: ['mx.example.com'],
  });
}

async function bootstrap(providers: Array<Type | ProviderDefinition>, gate?: MailInboundGate) {
  const gateProviders: ProviderDefinition[] = gate
    ? [defineProvider(MAIL_INBOUND_GATE, { useValue: gate })]
    : [];

  @Module({ providers: [...providers, ...gateProviders] })
  class App {}

  const app = await VelaFactory.create(App);
  disposers.push(() => app.dispose());
  return app;
}

describe('dispatchInboundEmail — gating', () => {
  it('runs no handler and reports gated:true when the gate fails (default DMARC)', async () => {
    const calls: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      handle(): void {
        calls.push('ran');
      }
    }

    const app = await bootstrap([Inbox]);
    const result = await dispatchInboundEmail(
      app.getContainer(),
      app.entrypoints,
      emailWith('fail'),
    );

    expect(result).toEqual({ gated: true, handled: 0, failed: ['dmarc'] });
    expect(calls).toEqual([]);
  });

  it('runs handlers when the gate passes', async () => {
    const received: InboundEmail[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      handle(email: InboundEmail): void {
        received.push(email);
      }
    }

    const app = await bootstrap([Inbox]);
    const result = await dispatchInboundEmail(
      app.getContainer(),
      app.entrypoints,
      emailWith('pass'),
    );

    expect(result.gated).toBe(false);
    expect(result.handled).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.subject).toBe('Help');
  });

  it('AND-composes a custom gate policy without an authentication bypass', async () => {
    const calls: string[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      handle(): void {
        calls.push('ran');
      }
    }

    const app = await bootstrap([Inbox], { require: ['dmarc'], policy: () => false });
    const result = await dispatchInboundEmail(
      app.getContainer(),
      app.entrypoints,
      emailWith('pass'),
    );

    expect(result.gated).toBe(true);
    expect(calls).toEqual([]);
  });

  it('fails closed when distinct module registrations contribute ambiguous gates', async () => {
    const firstGate: MailInboundGate = { require: ['dmarc'], policy: () => true };
    const secondGate: MailInboundGate = { require: ['dmarc'], policy: () => false };

    @Module({
      imports: [
        MailModule.forRoot({ from: 'first@example.com', inbound: { gate: firstGate } }),
        MailModule.forRoot({ from: 'second@example.com', inbound: { gate: secondGate } }),
      ],
    })
    class App {}

    const app = await VelaFactory.create(App);
    disposers.push(() => app.dispose());
    await expect(
      dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass')),
    ).rejects.toMatchObject({ code: 'inbound_rejected' });
  });
});

describe('dispatchInboundEmail — routing & pipeline', () => {
  it('runs only handlers whose match predicate does not return false', async () => {
    const ran: string[] = [];

    @Injectable()
    class Router {
      @OnInboundEmail({ match: (e) => e.to.some((a) => a.includes('support@')) })
      support(): void {
        ran.push('support');
      }

      @OnInboundEmail({ match: (e) => e.to.some((a) => a.includes('billing@')) })
      billing(): void {
        ran.push('billing');
      }

      @OnInboundEmail()
      always(): void {
        ran.push('always');
      }
    }

    const app = await bootstrap([Router]);
    const result = await dispatchInboundEmail(
      app.getContainer(),
      app.entrypoints,
      emailWith('pass'),
    );

    expect(ran.sort()).toEqual(['always', 'support']);
    expect(result.handled).toBe(2);
  });

  it('applies scoped guard + interceptor around the handler', async () => {
    const order: string[] = [];

    @Injectable()
    class InboxGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        order.push(`guard:${ctx.getType()}`);
        return true;
      }
    }

    @Injectable()
    class InboxInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        order.push('intercept:before');
        const out = await next.handle();
        order.push('intercept:after');
        return out;
      }
    }

    @Injectable()
    @UseGuards(InboxGuard)
    @UseInterceptors(InboxInterceptor)
    class Inbox {
      @OnInboundEmail()
      handle(): void {
        order.push('handler');
      }
    }

    const app = await bootstrap([Inbox, InboxGuard, InboxInterceptor]);
    await dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass'));

    expect(order).toEqual(['guard:mail:inbound', 'intercept:before', 'handler', 'intercept:after']);
  });

  it('applies module-level components to a controller that handles inbound email', async () => {
    const order: string[] = [];

    @Injectable()
    class ModuleGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        order.push(`guard:${ctx.getType()}`);
        return true;
      }
    }

    @Controller('/support')
    class SupportController {
      @OnInboundEmail()
      handle(): void {
        order.push('handler');
      }
    }

    @UseGuards(ModuleGuard)
    @Module({ providers: [ModuleGuard], controllers: [SupportController] })
    class SupportModule {}

    @Module({ imports: [SupportModule] })
    class App {}

    await VelaFactory.create(App).then((first) => first.dispose());
    const app = await VelaFactory.create(App);
    disposers.push(() => app.dispose());
    await dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass'));

    expect(order).toEqual(['guard:mail:inbound', 'handler']);
  });

  it('lets a scoped filter claim a handler error (no rethrow)', async () => {
    class KnownError extends Error {}
    const claimed: string[] = [];

    @Catch(KnownError)
    class KnownFilter implements ExceptionFilter {
      catch(error: unknown): void {
        claimed.push((error as Error).message);
      }
    }

    @Injectable()
    @UseFilters(KnownFilter)
    class Inbox {
      @OnInboundEmail()
      handle(): void {
        throw new KnownError('boom');
      }
    }

    const app = await bootstrap([Inbox, KnownFilter]);
    const result = await dispatchInboundEmail(
      app.getContainer(),
      app.entrypoints,
      emailWith('pass'),
    );

    expect(claimed).toEqual(['boom']);
    expect(result.gated).toBe(false);
    expect(result.handled).toBe(1);
  });

  it('reports then rethrows an unclaimed handler error', async () => {
    const reports: unknown[] = [];

    @Injectable()
    class Inbox {
      @OnInboundEmail()
      handle(): void {
        throw new Error('unclaimed');
      }
    }

    const app = await bootstrap([
      Inbox,
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: {
          report: (e: unknown) => {
            reports.push(e);
          },
        },
      }),
    ]);

    await expect(
      dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass')),
    ).rejects.toThrow('unclaimed');
    expect(reports).toHaveLength(1);
  });

  it('re-resolves a request-scoped handler by token per dispatch (lazy-safe)', async () => {
    let constructions = 0;

    @Injectable({ scope: Scope.REQUEST })
    class Inbox {
      constructor() {
        constructions += 1;
      }

      @OnInboundEmail()
      handle(): void {}
    }

    const app = await bootstrap([Inbox]);
    await dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass'));
    await dispatchInboundEmail(app.getContainer(), app.entrypoints, emailWith('pass'));

    expect(constructions).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import type { Context, ExecutionContext as HonoExecutionContext, Next } from 'hono';
import {
  APP_EXCEPTION_HANDLER,
  APP_MIDDLEWARE,
  EXECUTION_LIFETIME,
  REQUEST_CONTEXT,
  Controller,
  Inject,
  Injectable,
  Module,
  Post,
  Scope,
  UseGuards,
  VelaFactory,
  defineProvider,
  getRequestContainer,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
  type CanActivate,
  type ExecutionContext,
  type ExecutionLifetime,
  type RequestContext,
} from '../index';

function nativeContext() {
  const pending: Promise<unknown>[] = [];
  const context: HonoExecutionContext = {
    waitUntil(work) {
      pending.push(work);
    },
    passThroughOnException() {},
    props: {},
  };
  return { context, pending };
}

describe('HTTP request normalization', () => {
  it.each([false, true])(
    'shares one readable request between middleware, scoped guards, and controller (Content-Length: %s)',
    async (withLength) => {
      const middlewareContexts = new Map<string, RequestContext>();
      @Injectable({ scope: Scope.REQUEST })
      class Authenticate implements CanActivate {
        async canActivate(context: ExecutionContext) {
          const request = context.getRequest();
          const subject = request.headers.get('x-test-subject')!;
          setTrustedRequestIdentity(request, {
            principal: { issuer: 'test', subject, principalType: 'user' },
          });
          await Promise.resolve();
          return true;
        }
      }
      @Injectable({ scope: Scope.REQUEST })
      class AdmitTenant implements CanActivate {
        constructor(@Inject(REQUEST_CONTEXT) readonly requestContext: RequestContext) {}
        canActivate(context: ExecutionContext) {
          expect(this.requestContext.request).toBe(context.getRequest());
          const identity = getTrustedRequestIdentity(this.requestContext.request);
          if (!identity) return false;
          setTrustedRequestTenant(
            this.requestContext.request,
            identity,
            identity.principal.subject,
          );
          return true;
        }
      }
      @Controller('/normalized')
      @UseGuards(Authenticate, AdmitTenant)
      class Routes {
        constructor(@Inject(REQUEST_CONTEXT) readonly requestContext: RequestContext) {}
        @Post()
        async read() {
          const context = this.requestContext;
          const identity = getTrustedRequestIdentity(context.request);
          expect(context).toBe(middlewareContexts.get(context.id));
          expect(context.get('middleware')).toBe(true);
          expect(getTrustedRequestIdentity(context.request.clone())).toBeUndefined();
          return { tenant: identity?.tenantId, body: await context.request.json() };
        }
      }
      const middleware = {
        async use(context: Context, next: Next) {
          const requestContext = getRequestContainer(context).resolve(REQUEST_CONTEXT);
          expect(requestContext.request).toBe(context.req.raw);
          requestContext.set('middleware', true);
          middlewareContexts.set(requestContext.id, requestContext);
          await next();
          expect(getRequestContainer(context).resolve(REQUEST_CONTEXT)).toBe(requestContext);
        },
      };
      @Module({
        controllers: [Routes],
        providers: [
          Authenticate,
          AdmitTenant,
          defineProvider(APP_MIDDLEWARE, { useValue: middleware }),
        ],
      })
      class App {}
      const app = await VelaFactory.create(App);
      try {
        const replies = await Promise.all(
          ['tenant-a', 'tenant-b'].map(async (subject) => {
            const body = JSON.stringify({ subject });
            const headers = new Headers({
              'content-type': 'application/json',
              'x-test-subject': subject,
              'x-request-id': subject,
            });
            if (withLength) headers.set('content-length', String(body.length));
            const request = new Request('http://test/normalized', {
              method: 'POST',
              headers,
              body,
            });
            expect(request.headers.has('content-length')).toBe(withLength);
            const response = await app.fetch(request);
            expect(response.status).toBe(200);
            return response.json();
          }),
        );
        expect(replies).toEqual([
          { tenant: 'tenant-a', body: { subject: 'tenant-a' } },
          { tenant: 'tenant-b', body: { subject: 'tenant-b' } },
        ]);
        expect(middlewareContexts.size).toBe(2);
      } finally {
        await app.close();
      }
    },
  );

  it('seeds the normalized request for adapter-only routes', async () => {
    @Module({})
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [
        {
          name: 'normalized-adapter',
          onRoutesBuilt({ app }) {
            app.getHonoApp().post('/adapter', async (context) => {
              const requestContext = getRequestContainer(context).resolve(REQUEST_CONTEXT);
              expect(requestContext.request).toBe(context.req.raw);
              return context.json(await requestContext.request.json());
            });
          },
        },
      ],
    });
    try {
      const response = await app.fetch(
        new Request('http://test/adapter', {
          method: 'POST',
          body: JSON.stringify({ adapter: true }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ adapter: true });
    } finally {
      await app.close();
    }
  });

  it('keeps the context snapshot and does not transfer authority to a later request replacement', async () => {
    let snapshot: RequestContext | undefined;
    let replacement: Request | undefined;
    const middleware = {
      async use(context: Context, next: Next) {
        snapshot = getRequestContainer(context).resolve(REQUEST_CONTEXT);
        setTrustedRequestIdentity(snapshot.request, {
          principal: { issuer: 'test', subject: 'original', principalType: 'user' },
        });
        replacement = context.req.raw.clone();
        context.req.raw = replacement;
        await next();
        expect(getRequestContainer(context).resolve(REQUEST_CONTEXT)).toBe(snapshot);
        expect(snapshot.request).not.toBe(replacement);
      },
    };
    @Injectable()
    class RequireIdentity implements CanActivate {
      canActivate(context: ExecutionContext) {
        return getTrustedRequestIdentity(context.getRequest()) !== undefined;
      }
    }
    @Controller('/replacement')
    @UseGuards(RequireIdentity)
    class Routes {
      @Post() read() {
        throw new Error('replacement must not inherit authentication');
      }
    }
    @Module({
      controllers: [Routes],
      providers: [RequireIdentity, defineProvider(APP_MIDDLEWARE, { useValue: middleware })],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.fetch(
        new Request('http://test/replacement', {
          method: 'POST',
          body: '{}',
        }),
      );
      expect(response.status).toBe(403);
      await response.text();
      expect(snapshot).toBeDefined();
      expect(replacement).toBeDefined();
      expect(getTrustedRequestIdentity(snapshot!.request)?.principal.subject).toBe('original');
      expect(getTrustedRequestIdentity(replacement!)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it.each(['unlengthened', 'lengthened', 'body-error'] as const)(
    'seeds rejection reporting and closes the original lifetime on %s input',
    async (mode) => {
      const seen: RequestContext[] = [];
      const lifetimes: ExecutionLifetime[] = [];
      const events: string[] = [];
      let middlewareCalls = 0;
      const middleware = {
        async use(_context: Context, next: Next) {
          middlewareCalls++;
          await next();
        },
      };
      @Module({
        providers: [
          defineProvider(APP_MIDDLEWARE, { useValue: middleware }),
          defineProvider(APP_EXCEPTION_HANDLER, {
            scope: Scope.REQUEST,
            inject: [REQUEST_CONTEXT, EXECUTION_LIFETIME],
            useFactory: (request, lifetime) => {
              seen.push(request);
              lifetimes.push(lifetime);
              lifetime.defer(() => {
                events.push('deferred');
              });
              return {
                report() {},
                dispose() {
                  events.push('disposed');
                },
              };
            },
          }),
        ],
      })
      class App {}
      const app = await VelaFactory.create(App, { bodyLimit: 8 });
      const native = nativeContext();
      const headers = new Headers({ 'x-request-id': 'early-rejection' });
      if (mode === 'lengthened') headers.set('content-length', '9');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'body-error') controller.error(new Error('body-read-secret'));
          else {
            controller.enqueue(new TextEncoder().encode('123456789'));
            controller.close();
          }
        },
      });
      const init = { method: 'POST', headers, body, duplex: 'half' };
      const request = new Request('http://test/rejected', init);
      try {
        const response = await app.fetch(request, {}, native.context);
        expect(response.status).toBe(mode === 'body-error' ? 500 : 413);
        const text = await response.text();
        expect(text).not.toContain('body-read-secret');
        await Promise.all(native.pending);
        expect(middlewareCalls).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.request).toBe(request);
        expect(seen[0]?.id).toBe('early-rejection');
        expect(lifetimes[0]?.signal).toBe(request.signal);
        expect(lifetimes[0]?.active).toBe(false);
        expect(events).toEqual(['deferred', 'disposed']);
      } finally {
        await app.close();
      }
    },
  );
});

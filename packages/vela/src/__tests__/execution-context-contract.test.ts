import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { buildEntrypointExecutionContext } from '../entrypoint/execution-context';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import {
  buildExecutionContext,
  buildMiddlewareExecutionContext,
  VelaMiddlewareHost,
} from '../http/execution-context';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { getRequestContainer, setRequestContainer } from '../http/request-container';
import type { WsClient } from '../websocket/websocket.types';
import { buildWsExecutionContext } from '../websocket/ws-execution-context';

class HandlerHost {
  handle(): void {}
}

describe('execution context contracts', () => {
  it('exposes real HTTP objects and only accepts framework containers', async () => {
    const app = new Hono();
    const container = new Container();
    app.get('/', (c) => {
      const context = buildExecutionContext(c, HandlerHost, 'handle', 'FeatureModule');
      expect(context.getType()).toBe('http');
      expect(context.getClass()).toBe(HandlerHost);
      expect(context.getHandler()).toBe('handle');
      expect(context.getModuleId()).toBe('FeatureModule');
      expect(context.getContext()).toBe(c);
      expect(context.getRequest()).toBe(c.req.raw);
      expect(context.switchToHttp().getRequest()).toBe(c.req.raw);
      expect(context.switchToHttp().getResponse()).toBe(c);
      expect(context.getContainer()).toBeUndefined();
      expect(() => context.switchToWs()).toThrow('HTTP ExecutionContext');

      setRequestContainer(c, container);
      expect(context.getContainer()).toBe(container);
      c.set('container', { resolve: () => 'not a Container' });
      expect(context.getContainer()).toBe(container);
      expect(getRequestContainer(c)).toBe(container);

      // Param-decorator contexts reuse the declaring module recorded by the pipeline.
      expect(buildExecutionContext(c, HandlerHost, 'handle').getModuleId()).toBe('FeatureModule');
      const middleware = buildMiddlewareExecutionContext(c);
      expect(middleware.getClass()).toBe(VelaMiddlewareHost);
      expect(middleware.getContext()).toBe(c);
      return c.text('ok');
    });
    expect(await (await app.request('/')).text()).toBe('ok');
  });

  it('exposes the normalized socket and keeps its inbound payload unmodified', () => {
    const client: WsClient = {
      id: 'client-1',
      rooms: new Set(['room-1']),
      data: {},
      raw: undefined,
      send() {},
      sendRaw() {},
      join() {},
      leave() {},
      commit() {},
      close() {},
    };
    const payload = { message: 'hello' };
    const container = new Container();
    const context = buildWsExecutionContext(
      client,
      payload,
      HandlerHost,
      'onMessage',
      'chat',
      'ChatModule',
      container,
    );
    expect(context.getType()).toBe('ws');
    expect(context.getContainer()).toBe(container);
    expect(context.getModuleId()).toBe('ChatModule');
    expect(context.switchToWs().getClient()).toBe(client);
    expect(context.switchToWs().getData()).toBe(payload);
    expect(context.switchToWs().getPattern()).toBe('chat');
    expect(() => context.getContext()).toThrow('WebSocket ExecutionContext');
    expect(() => context.getRequest()).toThrow('WebSocket ExecutionContext');
    expect(() => context.switchToHttp()).toThrow('WebSocket ExecutionContext');
  });

  it('preserves custom entrypoint kinds and the scoped container through the pipeline', async () => {
    const root = new Container();
    const payload = { scheduledTime: 123 };
    const calls: string[] = [];
    const result = await runInEntrypointScope(root, async (scope) => {
      const context = buildEntrypointExecutionContext(
        'adapter:scheduled',
        HandlerHost,
        'tick',
        payload,
        'ScheduledModule',
        scope,
      );
      expect(scope).not.toBe(root);
      expect(context.getPayload()).toBe(payload);
      expect(context.getModuleId()).toBe('ScheduledModule');
      expect(() => context.getContext()).toThrow('adapter:scheduled');
      expect(() => context.getRequest()).toThrow('adapter:scheduled');
      expect(() => context.switchToHttp()).toThrow('adapter:scheduled');
      expect(() => context.switchToWs()).toThrow('adapter:scheduled');
      return PipelineRunner.run({
        context,
        guards: [
          {
            canActivate(host) {
              expect(host.getType()).toBe('adapter:scheduled');
              expect(host.getContainer()).toBe(scope);
              calls.push('guard');
              return true;
            },
          },
        ],
        interceptors: [
          {
            async intercept(host, next) {
              expect(host.getContainer()).toBe(scope);
              calls.push('interceptor');
              return next.handle();
            },
          },
        ],
        resolveArgs: async () => [payload],
        invoke: async (args) => {
          calls.push('handler');
          return args[0];
        },
      });
    });
    expect(result).toBe(payload);
    expect(calls).toEqual(['guard', 'interceptor', 'handler']);
  });
});

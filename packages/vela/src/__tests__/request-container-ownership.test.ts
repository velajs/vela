import { describe, expect, it } from 'vitest';
import {
  Container,
  Controller,
  Get,
  Module,
  REQUEST_CONTEXT,
  VelaFactory,
  getCurrentContainer,
  getRequestContainer,
} from '../index';

describe('framework-owned request containers', () => {
  it('ignores application Hono variables while preserving scope and ambient access', async () => {
    const foreign = new Container();
    const scopes = new Set<Container>();

    @Controller('/scope')
    class ScopeController {
      @Get()
      handle() {
        const container = getCurrentContainer();
        expect(container).not.toBe(foreign);
        scopes.add(container);
        return { id: container.resolve(REQUEST_CONTEXT).id };
      }
    }

    @Module({ controllers: [ScopeController] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule, {
      ambientContainer: true,
      middleware: [
        async (context, next) => {
          const actual = getRequestContainer(context);
          context.set('container', foreign);
          expect(getRequestContainer(context)).toBe(actual);
          expect(getCurrentContainer()).toBe(actual);
          await next();
        },
      ],
    });
    try {
      const responses = await Promise.all([
        app.getHonoApp().request('/scope'),
        app.getHonoApp().request('/scope'),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(scopes.size).toBe(2);
      expect(scopes.has(app.getContainer())).toBe(false);
    } finally {
      await app.close();
    }
  });
});

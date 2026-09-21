import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Container } from '../container/container';
import { createExecutionScope } from '../entrypoint/execution-scope';
import { enableAmbientContainer, getCurrentContainer } from '../http/ambient';
import { getRequestContainer, setRequestContainer } from '../http/request-container';

it('rejects ambient and explicit request access after a managed scope closes', async () => {
  const release = Promise.withResolvers<void>();
  const root = new Container();
  const app = new Hono();
  const failures: Promise<unknown>[] = [];
  app.use('*', enableAmbientContainer());
  app.get('/', async (context) => {
    const scope = createExecutionScope(root);
    setRequestContainer(context, scope.container);
    expect(getCurrentContainer()).toBe(scope.container);
    expect(getRequestContainer(context)).toBe(scope.container);
    failures.push(
      (async () => {
        await release.promise;
        expect(() => getCurrentContainer()).toThrow('Execution lifetime is closed');
        expect(() => getRequestContainer(context)).toThrow('Execution lifetime is closed');
      })(),
    );
    await scope.finish();
    return context.text('complete');
  });
  expect(await (await app.request('/')).text()).toBe('complete');
  release.resolve();
  await Promise.all(failures);
});

describe('unmanaged request adapters', () => {
  it('retains the existing explicit request-container lookup behavior', async () => {
    const root = new Container();
    const app = new Hono();
    app.use('*', enableAmbientContainer());
    app.get('/', (context) => {
      const child = root.createChild();
      setRequestContainer(context, child);
      expect(getCurrentContainer()).toBe(child);
      expect(getRequestContainer(context)).toBe(child);
      return context.text('legacy');
    });
    expect(await (await app.request('/')).text()).toBe('legacy');
  });
});

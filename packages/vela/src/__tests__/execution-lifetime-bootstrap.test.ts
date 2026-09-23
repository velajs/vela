import { expect, it } from 'vitest';
import {
  EXECUTION_LIFETIME,
  Inject,
  Injectable,
  Module,
  VelaFactory,
  type ExecutionLifetime,
} from '../index';
import { runInEntrypointScope } from '../module-kit';

it('makes the managed lifetime injectable from feature modules without root resolution', async () => {
  @Injectable()
  class Consumer {
    constructor(@Inject(EXECUTION_LIFETIME) readonly lifetime: ExecutionLifetime) {}
  }
  @Module({ providers: [Consumer] })
  class AppModule {}
  const app = await VelaFactory.create(AppModule);
  try {
    expect(() => app.get(EXECUTION_LIFETIME)).toThrow(
      /request-scoped provider InjectionToken\(vela\.ExecutionLifetime\) on the root/,
    );
    const lifetimes: ExecutionLifetime[] = [];
    await Promise.all(
      [1, 2].map(() =>
        runInEntrypointScope(app.getContainer(), async (child) => {
          const consumer = await child.resolveAsync(Consumer);
          expect(consumer.lifetime.active).toBe(true);
          lifetimes.push(consumer.lifetime);
        }),
      ),
    );
    expect(lifetimes[0]?.id).not.toBe(lifetimes[1]?.id);
    expect(lifetimes.every((lifetime) => !lifetime.active)).toBe(true);
  } finally {
    await app.dispose();
  }
});

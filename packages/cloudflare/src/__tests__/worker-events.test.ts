import { describe, expect, it } from 'vitest';
import { Module } from '@velajs/vela';
import { createCloudflareWorker, defineCloudflareApp } from '../index';

@Module({})
class AppModule {}

// Each test file loads its own modules: nothing here imported @OnEmail() or
// @OnTail() before these Workers were defined.
describe('optional Worker handlers', () => {
  it('appear when a module imports their decorator, also on Workers defined before', async () => {
    const early = defineCloudflareApp(AppModule).worker;
    // The platform sees no handler for an event nothing handles.
    expect(Object.hasOwn(early, 'email')).toBe(false);
    expect(Object.hasOwn(early, 'tail')).toBe(false);

    await import('../email');
    expect(typeof early.email).toBe('function');
    expect(Object.hasOwn(early, 'tail')).toBe(false);
    const later = createCloudflareWorker(AppModule);
    expect(typeof later.email).toBe('function');

    await import('../tail');
    expect(typeof early.tail).toBe('function');
    expect(typeof later.tail).toBe('function');
    // Enumerable, so an entry that spreads the Worker keeps them.
    expect(Object.keys({ ...early }).sort()).toEqual([
      'email',
      'fetch',
      'queue',
      'scheduled',
      'tail',
    ]);
  });

  it('keep spread semantics: a handler written after the spread wins', async () => {
    await import('../email');
    const worker = createCloudflareWorker(AppModule);
    const entry = { async email(): Promise<void> {}, ...worker };
    // The Worker's own handler is spread over the entry's, as any property is.
    expect(entry.email).toBe(worker.email);
    const own = { ...worker, async email(): Promise<void> {} };
    expect(own.email).not.toBe(worker.email);
  });
});

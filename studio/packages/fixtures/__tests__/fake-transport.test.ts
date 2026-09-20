import { describe, expect, it } from 'vitest';
import type { StudioOpReq } from '@velajs/studio-protocol';
import {
  capabilitiesAllOn,
  FakeAdminError,
  FakeAdminTransport,
  fakeTable,
  makeErrorBody,
  routes,
} from '../src/index';

describe('FakeAdminTransport', () => {
  it('resolves a canned value responder', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    await expect(transport.rpc('app.routes', {})).resolves.toEqual(routes);
    await expect(transport.rpc('studio.capabilities', {})).resolves.toEqual(capabilitiesAllOn);
  });

  it('resolves a function responder with the dispatched args', async () => {
    const transport = new FakeAdminTransport({
      'auth.users': (args: StudioOpReq<'auth.users'>) => ({
        rows: [],
        nextCursor: args.q ?? 'none',
      }),
    });
    const res = await transport.rpc('auth.users', { q: 'ada' });
    expect(res.nextCursor).toBe('ada');
    expect(transport.calls).toEqual([{ op: 'auth.users', args: { q: 'ada' } }]);
  });

  it('rejects an unregistered op with STUDIO_UNKNOWN_OP (404)', async () => {
    const transport = new FakeAdminTransport();
    await expect(transport.rpc('app.modules', {})).rejects.toBeInstanceOf(FakeAdminError);
    try {
      await transport.rpc('app.modules', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      const fake = err as FakeAdminError;
      expect(fake.body.code).toBe('STUDIO_UNKNOWN_OP');
      expect(fake.status).toBe(404);
    }
  });

  it('rejects with a forced error envelope', async () => {
    const transport = new FakeAdminTransport(fakeTable(), {
      errors: { 'app.routes': makeErrorBody('STUDIO_OP_FORBIDDEN', 403, { hint: 'read-only' }) },
    });
    try {
      await transport.rpc('app.routes', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      const fake = err as FakeAdminError;
      expect(fake.status).toBe(403);
      expect(fake.body.hint).toBe('read-only');
    }
  });

  it('applies simulated latency and records every call', async () => {
    const transport = new FakeAdminTransport(fakeTable(), { latencyMs: 5 });
    const started = Date.now();
    await transport.rpc('app.routes', {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(transport.calls.map((c) => c.op)).toEqual(['app.routes']);
  });
});

import { describe, expect, it } from 'vitest';
import type { StudioConfirmChallenge } from '@velajs/studio-protocol';
import { FakeAdminError, FakeAdminTransport, GENERATE_ROWS_MAX, fakeTable } from '../src/index';

/** Narrow a thrown value to the 428 confirm challenge it must carry. */
function challengeOf(err: unknown): StudioConfirmChallenge {
  expect(err).toBeInstanceOf(FakeAdminError);
  const fake = err as FakeAdminError;
  expect(fake.status).toBe(428);
  expect(fake.body.code).toBe('STUDIO_CONFIRM_REQUIRED');
  const details = fake.body.details as StudioConfirmChallenge;
  expect(typeof details.confirmToken).toBe('string');
  expect(typeof details.expiresAt).toBe('number');
  expect(typeof details.summary).toBe('string');
  return details;
}

describe('data write responders — 428 confirm challenge', () => {
  it('writeRow (create) synthesizes an id and echoes the patch', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const row = await transport.rpc('data.writeRow', {
      model: 'user',
      patch: { email: 'new@example.com', name: 'New' },
    });
    expect(typeof row.id).toBe('string');
    expect(row.email).toBe('new@example.com');
  });

  it('writeRow (update) preserves the supplied id', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const row = await transport.rpc('data.writeRow', {
      model: 'user',
      id: 'u_001',
      patch: { name: 'Renamed' },
    });
    expect(row.id).toBe('u_001');
    expect(row.name).toBe('Renamed');
  });

  it('deleteRows without a token throws a 428 with a human summary', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    try {
      await transport.rpc('data.deleteRows', {
        model: 'user',
        ids: ['u_001', 'u_002', 'u_003'],
        mode: 'hard',
        confirmToken: '',
      });
      expect.unreachable('should have challenged');
    } catch (err) {
      const details = challengeOf(err);
      expect(details.summary).toBe('hard-delete 3 rows from user');
    }
  });

  it('deleteRows with the issued token succeeds, then the token is single-use', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const args = { model: 'user', ids: ['u_001'], mode: 'soft' as const, confirmToken: '' };

    let token = '';
    try {
      await transport.rpc('data.deleteRows', args);
      expect.unreachable('should have challenged');
    } catch (err) {
      token = challengeOf(err).confirmToken;
    }

    const ok = await transport.rpc('data.deleteRows', { ...args, confirmToken: token });
    expect(ok.deleted).toBe(1);

    // Replaying the SAME (now spent) token re-challenges with a fresh token.
    try {
      await transport.rpc('data.deleteRows', { ...args, confirmToken: token });
      expect.unreachable('spent token should re-challenge');
    } catch (err) {
      const fresh = challengeOf(err);
      expect(fresh.confirmToken).not.toBe(token);
    }
  });

  it('clearTable follows the same challenge → confirm flow', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    let token = '';
    try {
      await transport.rpc('data.clearTable', { model: 'post', confirmToken: '' });
      expect.unreachable('should have challenged');
    } catch (err) {
      const details = challengeOf(err);
      expect(details.summary).toContain('post');
      token = details.confirmToken;
    }
    const ok = await transport.rpc('data.clearTable', { model: 'post', confirmToken: token });
    expect(ok.deleted).toBeGreaterThan(0);
  });

  it('generateRows over the cap throws a 400 carrying the limit hint', async () => {
    const transport = new FakeAdminTransport(fakeTable());
    const ok = await transport.rpc('data.generateRows', { model: 'user', count: 10 });
    expect(ok.inserted).toBe(10);

    try {
      await transport.rpc('data.generateRows', { model: 'user', count: GENERATE_ROWS_MAX + 1 });
      expect.unreachable('over-cap should throw');
    } catch (err) {
      const fake = err as FakeAdminError;
      expect(fake.status).toBe(400);
      expect(fake.body.hint).toContain(String(GENERATE_ROWS_MAX));
    }
  });
});

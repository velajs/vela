import { describe, expect, it } from 'vitest';
import { buildMessage } from '../build';
import { MailError } from '../mail.error';
import type { BuiltMessage } from '../types';
import { reparseBuiltWire } from '../wire';
import { ADDRESS_VECTORS, CONTROL_VECTORS } from './vectors';

async function validWire(): Promise<BuiltMessage> {
  return buildMessage(
    { to: 'a@b.com', cc: 'c@d.com', subject: 'Hi', text: 'body', headers: { 'X-Tag': 'ok' } },
    { from: 'sender@example.com' },
  );
}

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MailError) return err.code;
    throw err;
  }
  throw new Error('expected a MailError');
}

describe('reparseBuiltWire', () => {
  it('round-trips a valid built message through JSON', async () => {
    const built = await validWire();
    const wire: unknown = JSON.parse(JSON.stringify(built));
    const reparsed = reparseBuiltWire(wire);
    expect(reparsed.to).toEqual(built.to);
    expect(reparsed.subject).toBe(built.subject);
    expect(reparsed.envelope).toEqual(built.envelope);
    expect(reparsed.headers).toEqual(built.headers);
  });

  it('rejects a non-object payload', async () => {
    expect(await codeOf(() => reparseBuiltWire('nope'))).toBe('invalid_message');
    expect(await codeOf(() => reparseBuiltWire(null))).toBe('invalid_message');
  });

  it('rejects a payload with no recipients', async () => {
    expect(
      await codeOf(() =>
        reparseBuiltWire({ from: { email: 'a@b.com' }, to: [], subject: 'x', text: 'y' }),
      ),
    ).toBe('invalid_message');
  });

  it('rejects a non-string subject/body/header', async () => {
    const base = { from: { email: 'a@b.com' }, to: [{ email: 'c@d.com' }] };
    expect(await codeOf(() => reparseBuiltWire({ ...base, subject: 5, text: 'y' }))).toBe(
      'invalid_message',
    );
    expect(await codeOf(() => reparseBuiltWire({ ...base, subject: 'x', html: 7 }))).toBe(
      'invalid_message',
    );
    expect(
      await codeOf(() =>
        reparseBuiltWire({ ...base, subject: 'x', text: 'y', headers: { 'X-Tag': 9 } }),
      ),
    ).toBe('invalid_message');
  });

  // The queue is an untrusted boundary: a poisoned wire must be rejected on
  // dequeue even though the producer already guarded it before enqueue.
  describe('dequeue-side injection matrix', () => {
    it.each(CONTROL_VECTORS)('rejects $label injected into the subject', async ({ char }) => {
      const built = await validWire();
      const poisoned = { ...built, subject: `Hi${char}there` };
      expect(await codeOf(() => reparseBuiltWire(poisoned))).toBe('invalid_header');
    });

    it.each(ADDRESS_VECTORS)('rejects $label injected into a recipient email', async ({ char }) => {
      const built = await validWire();
      const poisoned = { ...built, to: [{ email: `bad${char}@b.com` }] };
      expect(await codeOf(() => reparseBuiltWire(poisoned))).toBe('invalid_address');
    });

    it.each(CONTROL_VECTORS)(
      'rejects $label injected into a custom header value',
      async ({ char }) => {
        const built = await validWire();
        const poisoned = { ...built, headers: { 'X-Tag': `a${char}b` } };
        expect(await codeOf(() => reparseBuiltWire(poisoned))).toBe('invalid_header');
      },
    );

    it.each(CONTROL_VECTORS)(
      'rejects $label injected into a custom header name',
      async ({ char }) => {
        const built = await validWire();
        const poisoned = { ...built, headers: { [`X-${char}`]: 'v' } };
        expect(await codeOf(() => reparseBuiltWire(poisoned))).toBe('invalid_header');
      },
    );
  });
});

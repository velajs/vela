import { describe, expect, it } from 'vitest';
import { createMailCatcher } from '../transports/catcher';
import {
  assertCount,
  assertNotSent,
  assertSent,
  extractLink,
  lastMessage,
  waitForMail,
} from '../testing';
import type { BuiltMessage } from '../types';

function built(overrides: Partial<BuiltMessage> = {}): BuiltMessage {
  return {
    from: { email: 'sender@example.com' },
    to: [{ email: 'a@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Welcome',
    text: 'Confirm at https://app.example.com/verify?token=abc&amp;next=/home',
    headers: {},
    envelope: { from: 'sender@example.com', to: ['a@b.com'] },
    ...overrides,
  };
}

describe('/testing helpers', () => {
  it('assertSent returns the matching message', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built());
    const hit = assertSent(catcher, { to: 'a@b.com', subjectMatch: 'Welc' });
    expect(hit.subject).toBe('Welcome');
  });

  it('assertSent throws a diagnostic Error on a miss', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built());
    expect(() => assertSent(catcher, { to: 'nobody@x.com' })).toThrow(/a@b.com/);
  });

  it('assertNotSent passes when nothing matches and throws when it does', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built());
    expect(() => assertNotSent(catcher, { to: 'nobody@x.com' })).not.toThrow();
    expect(() => assertNotSent(catcher, { subjectMatch: 'Welcome' })).toThrow(/Welcome/);
  });

  it('assertCount checks the captured total', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built());
    await catcher.deliver(built({ subject: 'Second' }));
    expect(() => assertCount(catcher, 2)).not.toThrow();
    expect(() => assertCount(catcher, 1)).toThrow(/expected 1/);
  });

  it('lastMessage returns the most recent capture', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built({ subject: 'First' }));
    await catcher.deliver(built({ subject: 'Last' }));
    expect(lastMessage(catcher).subject).toBe('Last');
  });

  it('lastMessage throws when empty', () => {
    const catcher = createMailCatcher();
    expect(() => lastMessage(catcher)).toThrow(/no messages/);
  });

  it('extractLink finds and decodes the first link (text)', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built());
    const link = extractLink(lastMessage(catcher));
    expect(link).toBe('https://app.example.com/verify?token=abc&next=/home');
  });

  it('extractLink prefers the html body when present', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(
      built({
        html: '<a href="https://html.example.com/x">go</a>',
        text: 'https://text.example.com/y',
      }),
    );
    expect(extractLink(lastMessage(catcher))).toBe('https://html.example.com/x');
  });

  it('extractLink honors a match filter', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(
      built({ text: 'a https://one.example.com b https://two.example.com/reset' }),
    );
    expect(extractLink(lastMessage(catcher), { match: 'reset' })).toBe(
      'https://two.example.com/reset',
    );
  });

  it('extractLink throws when no link is present', async () => {
    const catcher = createMailCatcher();
    await catcher.deliver(built({ text: 'no links here' }));
    expect(() => extractLink(lastMessage(catcher))).toThrow(/no .*link/);
  });

  it('waitForMail resolves on a matching capture', async () => {
    const catcher = createMailCatcher();
    const pending = waitForMail(catcher, { subjectMatch: 'Async' }, { pollMs: 1, timeoutMs: 500 });
    await catcher.deliver(built({ subject: 'Async welcome' }));
    expect((await pending).subject).toBe('Async welcome');
  });
});

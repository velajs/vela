import { describe, expect, it } from 'vitest';

import { buildMessage } from '../build';
import { parseInboundEmail } from '../inbound/parse';
import { MailError } from '../mail.error';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[next() % values.length]!;
}

function randomText(next: () => number, alphabet: string, maxLength: number): string {
  const length = next() % (maxLength + 1);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[next() % alphabet.length];
  }
  return value;
}

function randomCase(next: () => number, value: string): string {
  return [...value]
    .map((character) => (next() % 2 === 0 ? character.toUpperCase() : character.toLowerCase()))
    .join('');
}

async function errorCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof MailError) return error.code;
    throw error;
  }
  return undefined;
}

describe('security property sweep — outbound mail headers', () => {
  it('rejects reserved headers independent of casing and reserved prefix suffixes', async () => {
    const next = seeded(0x5afe_4a11);
    const exact = [
      'authentication-results',
      'bcc',
      'cc',
      'content-transfer-encoding',
      'content-type',
      'date',
      'delivered-to',
      'dkim-signature',
      'errors-to',
      'from',
      'in-reply-to',
      'message-id',
      'mime-version',
      'received',
      'references',
      'reply-to',
      'return-path',
      'sender',
      'subject',
      'to',
    ] as const;
    const prefixes = ['arc-', 'content-', 'resent-'] as const;

    for (let sample = 0; sample < 360; sample += 1) {
      const base =
        sample % 2 === 0
          ? pick(next, exact)
          : `${pick(next, prefixes)}${randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789-', 24) || 'x'}`;
      const name = randomCase(next, base);
      const code = await errorCode(() =>
        buildMessage(
          { to: 'recipient@example.com', subject: 'Safe', text: 'body', headers: { [name]: 'x' } },
          { from: 'sender@example.com' },
        ),
      );
      expect(code).toBe('invalid_header');
    }
  });

  it('rejects randomized header-name and header-value control injection', async () => {
    const next = seeded(0x1a2b_3c4d);
    const controls = ['\u0000', '\n', '\r', '\u0085', '\u2028', '\u2029'] as const;

    for (let sample = 0; sample < 300; sample += 1) {
      const control = pick(next, controls);
      const prefix = randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789', 20);
      const suffix = randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789', 20);
      const valueCode = await errorCode(() =>
        buildMessage(
          {
            to: 'recipient@example.com',
            subject: 'Safe',
            text: 'body',
            headers: { 'X-Fuzz': `${prefix}${control}${suffix}` },
          },
          { from: 'sender@example.com' },
        ),
      );
      const nameCode = await errorCode(() =>
        buildMessage(
          {
            to: 'recipient@example.com',
            subject: 'Safe',
            text: 'body',
            headers: { [`X-${prefix}${control}${suffix}`]: 'safe' },
          },
          { from: 'sender@example.com' },
        ),
      );

      expect(valueCode).toBe('invalid_header');
      expect(nameCode).toBe('invalid_header');
    }
  });
});

describe('security property sweep — inbound raw headers', () => {
  it('round-trips bounded randomized header blocks into a null-prototype map', () => {
    const next = seeded(0x1b0d_b0d7);

    for (let sample = 0; sample < 400; sample += 1) {
      const name = `X-Fuzz-${sample.toString(16)}`;
      const value = randomText(
        next,
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,/_-',
        96,
      );
      const subject = randomText(
        next,
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
        64,
      );
      const source = [
        `${name}: ${value}`,
        `Subject: ${subject}`,
        'Authentication-Results: attacker.invalid; dkim=pass; spf=pass; dmarc=pass',
        'To: recipient@example.com',
        '',
        randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789\r\n ', 128),
      ].join('\r\n');

      const parsed = parseInboundEmail(source);
      expect(Object.getPrototypeOf(parsed.headers)).toBeNull();
      expect(parsed.headers[name.toLowerCase()]).toBe(value.trim());
      expect(parsed.authentication).toEqual({ dkim: null, spf: null, dmarc: null });
      expect(Object.hasOwn(parsed.headers, 'authentication-results')).toBe(false);
      expect(parsed.rawText()).toBe(source);
    }
  });

  it('rejects control characters that remain inside raw header names or values', () => {
    const next = seeded(0x4ead_e25);
    const controls = ['\u0000', '\r', '\u0085', '\u2028', '\u2029'] as const;

    for (let sample = 0; sample < 300; sample += 1) {
      const control = pick(next, controls);
      const valueSource = `X-Fuzz: before${control}after\r\nTo: recipient@example.com\r\n\r\nbody`;
      const nameSource = `X-${sample}${control}-Fuzz: value\r\nTo: recipient@example.com\r\n\r\nbody`;

      for (const source of [valueSource, nameSource]) {
        expect(() => parseInboundEmail(source)).toThrowError(
          expect.objectContaining<Partial<MailError>>({ code: 'invalid_header' }),
        );
      }
    }
  });

  it('classifies randomized messages without a header/body separator as malformed', () => {
    const next = seeded(0x0bad_f00d);

    for (let sample = 0; sample < 300; sample += 1) {
      const source = randomText(
        next,
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:;,. -',
        256,
      );
      expect(() => parseInboundEmail(source)).toThrowError(
        expect.objectContaining<Partial<MailError>>({ code: 'inbound_malformed' }),
      );
    }
  });
});

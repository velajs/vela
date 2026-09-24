import { describe, expect, it } from 'vitest';

import { verifyInvocation } from '../crypto/invocation';
import { signUrl, verifySignedUrl } from '../security/index.js';
import { verifyAndConsumeWebSocketTicket } from '../websocket/socket-ticket';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomText(next: () => number, alphabet: string, maxLength: number): string {
  const length = next() % (maxLength + 1);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[next() % alphabet.length];
  }
  return value;
}

describe('security property sweep — URL boundaries', () => {
  it('binds randomized signed URLs to their canonical path and query', async () => {
    const next = seeded(0x51a7_5eed);
    const scope = { method: 'GET', purpose: 'fuzz:download' } as const;

    for (let sample = 0; sample < 96; sample += 1) {
      const path = `/tenant-${next() % 17}/objects/${next().toString(16)}`;
      const query = new URLSearchParams({
        cursor: randomText(next, 'abcdefghijklmnopqrstuvwxyz0123456789', 24),
        page: String(1 + (next() % 100)),
      });
      const signed = await signUrl(`${path}?${query.toString()}`, 'fuzz-secret', {
        expiresIn: 300,
        ...scope,
      });

      expect(await verifySignedUrl(signed, 'fuzz-secret', scope)).toBe(true);
      expect(await verifySignedUrl(`${signed}&tampered=${sample}`, 'fuzz-secret', scope)).toBe(
        false,
      );
      expect(
        await verifySignedUrl(signed.replace('/objects/', '/private/'), 'fuzz-secret', scope),
      ).toBe(false);
    }
  });
});

describe('security property sweep — malformed signed capabilities', () => {
  it('makes malformed signed URLs fail closed without throwing', async () => {
    const next = seeded(0xbadc_0de5);
    const scope = { method: 'GET', purpose: 'fuzz:download' } as const;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-%!@#$^&*.';

    for (let sample = 0; sample < 400; sample += 1) {
      const requestedLength = sample % 2 === 0 ? next() % 43 : 44 + (next() % 80);
      let signature = '';
      while (signature.length < requestedLength) {
        signature += alphabet[next() % alphabet.length];
      }
      const candidate = `/objects/${randomText(next, alphabet, 32)}?expires=4000000000&signature=${signature}`;
      await expect(verifySignedUrl(candidate, 'fuzz-secret', scope)).resolves.toBe(false);
    }
  });

  it('makes malformed invocation and socket-ticket tokens fail closed', async () => {
    const next = seeded(0xc0de_cafe);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-%!@#$^&*';
    const nonceStore = {
      claim: async () => {
        throw new Error('malformed input must not reach nonce consumption');
      },
    };

    for (let sample = 0; sample < 400; sample += 1) {
      const claim = randomText(next, alphabet, 96);
      const signature = randomText(next, alphabet, 96);
      const token = sample % 3 === 0 ? `${claim}.${signature}.extra` : `${claim}.${signature}`;

      await expect(
        verifyInvocation(token, 'fuzz-secret', { now: 2_000_000_000 }),
      ).resolves.toBeNull();
      await expect(
        verifyAndConsumeWebSocketTicket(token, {
          secret: 'fuzz-secret',
          gatewayPath: '/rooms/:room/ws',
          room: 'room-1',
          nonceStore,
          nowMs: 2_000_000_000_000,
        }),
      ).resolves.toBe(false);
    }
  });
});

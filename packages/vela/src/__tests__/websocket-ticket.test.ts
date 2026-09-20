import { describe, expect, it } from 'vitest';
import { fromBase64Url, importHmacKey, toBase64Url } from '../crypto/hmac';
import { MemoryNonceStore } from '../dispatch/nonce-store';
import {
  issueWebSocketTicket,
  verifyAndConsumeWebSocketTicket,
  WEBSOCKET_TICKET_AUDIENCE,
  WEBSOCKET_TICKET_MAX_TTL_MS,
  WEBSOCKET_TICKET_PURPOSE,
  type IssueWebSocketTicketOptions,
  type WebSocketTicketClaim,
  type WebSocketTicketNonceStore,
} from '../websocket/socket-ticket';

const SECRET = 'test-only-websocket-ticket-secret';
const NOW_MS = 1_900_000_000_000;
const BASE_OPTIONS = {
  secret: SECRET,
  gatewayPath: '/tenants/:tenantId/rooms/:room/ws',
  room: 'room:engineering',
  principal: {
    issuer: 'https://identity.example.com',
    subject: 'user-123',
    principalType: 'user',
  },
  tenantId: 'tenant-456',
  nowMs: NOW_MS,
  ttlMs: 20_000,
} satisfies IssueWebSocketTicketOptions;

class AtomicTestNonceStore implements WebSocketTicketNonceStore {
  readonly calls: Array<{ nonce: string; expEpochSeconds: number }> = [];
  private readonly seen = new Set<string>();

  async claim(nonce: string, expEpochSeconds: number): Promise<boolean> {
    this.calls.push({ nonce, expEpochSeconds });
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

function verificationOptions(store: WebSocketTicketNonceStore, nowMs = NOW_MS + 1) {
  return {
    secret: SECRET,
    gatewayPath: BASE_OPTIONS.gatewayPath,
    room: BASE_OPTIONS.room,
    nonceStore: store,
    nowMs,
  };
}

function decodeClaim(token: string): WebSocketTicketClaim {
  const claimPart = token.slice(0, token.indexOf('.'));
  return JSON.parse(new TextDecoder().decode(fromBase64Url(claimPart))) as WebSocketTicketClaim;
}

async function signForeignClaim(value: unknown, secret = SECRET): Promise<string> {
  const claimPart = toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importHmacKey(secret),
    new TextEncoder().encode(claimPart),
  );
  return `${claimPart}.${toBase64Url(signature)}`;
}

describe('WebSocket socket tickets', () => {
  it('issues an exact, fixed-purpose claim and consumes it only once', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const store = new AtomicTestNonceStore();
    const claim = await verifyAndConsumeWebSocketTicket(token, verificationOptions(store));

    expect(claim).toEqual({
      aud: WEBSOCKET_TICKET_AUDIENCE,
      purpose: WEBSOCKET_TICKET_PURPOSE,
      gatewayPath: BASE_OPTIONS.gatewayPath,
      room: BASE_OPTIONS.room,
      principal: BASE_OPTIONS.principal,
      tenantId: BASE_OPTIONS.tenantId,
      issuedAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 20_000,
      nonce: expect.any(String),
    });
    expect(store.calls).toEqual([
      {
        nonce: (claim as WebSocketTicketClaim).nonce,
        expEpochSeconds: Math.ceil((NOW_MS + 20_000) / 1_000),
      },
    ]);
    await expect(verifyAndConsumeWebSocketTicket(token, verificationOptions(store))).resolves.toBe(
      false,
    );
  });

  it('uses an atomic nonce claim when two consumers race', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const store = new AtomicTestNonceStore();
    const results = await Promise.all([
      verifyAndConsumeWebSocketTicket(token, verificationOptions(store)),
      verifyAndConsumeWebSocketTicket(token, verificationOptions(store)),
    ]);

    expect(results.filter((result) => result !== false)).toHaveLength(1);
    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(store.calls).toHaveLength(2);
  });

  it('is structurally compatible with Vela MemoryNonceStore', async () => {
    const token = await issueWebSocketTicket({ ...BASE_OPTIONS, nowMs: Date.now() });
    const store: WebSocketTicketNonceStore = new MemoryNonceStore();

    expect(
      await verifyAndConsumeWebSocketTicket(token, {
        ...verificationOptions(store),
        nowMs: Date.now(),
      }),
    ).not.toBe(false);
    await expect(
      verifyAndConsumeWebSocketTicket(token, {
        ...verificationOptions(store),
        nowMs: Date.now(),
      }),
    ).resolves.toBe(false);
  });

  it('rejects wrong gateway and room bindings without consuming the nonce', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const store = new AtomicTestNonceStore();

    await expect(
      verifyAndConsumeWebSocketTicket(token, {
        ...verificationOptions(store),
        room: 'room:finance',
      }),
    ).resolves.toBe(false);
    await expect(
      verifyAndConsumeWebSocketTicket(token, {
        ...verificationOptions(store),
        gatewayPath: '/other/:room/ws',
      }),
    ).resolves.toBe(false);
    expect(store.calls).toHaveLength(0);
    expect(await verifyAndConsumeWebSocketTicket(token, verificationOptions(store))).not.toBe(
      false,
    );
  });

  it('returns false for tampering, a wrong secret, and malformed tokens', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const separator = token.indexOf('.');
    const claimPart = token.slice(0, separator);
    const signaturePart = token.slice(separator + 1);
    const tamperedClaim = `${claimPart[0] === 'A' ? 'B' : 'A'}${claimPart.slice(1)}.${signaturePart}`;
    const tamperedSignature = `${claimPart}.${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`;
    const malformed: unknown[] = [
      undefined,
      null,
      {},
      '',
      '.',
      'one-part',
      'a.b.c',
      '***.***',
      `${'a'.repeat(6_001)}.x`,
    ];

    for (const candidate of [tamperedClaim, tamperedSignature, ...malformed]) {
      await expect(
        verifyAndConsumeWebSocketTicket(candidate, verificationOptions(new AtomicTestNonceStore())),
      ).resolves.toBe(false);
    }
    await expect(
      verifyAndConsumeWebSocketTicket(token, {
        ...verificationOptions(new AtomicTestNonceStore()),
        secret: 'wrong-secret',
      }),
    ).resolves.toBe(false);
  });

  it('rejects expired and not-yet-valid tickets before nonce consumption', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const expiredStore = new AtomicTestNonceStore();
    await expect(
      verifyAndConsumeWebSocketTicket(token, verificationOptions(expiredStore, NOW_MS + 20_000)),
    ).resolves.toBe(false);
    expect(expiredStore.calls).toHaveLength(0);

    const futureStore = new AtomicTestNonceStore();
    await expect(
      verifyAndConsumeWebSocketTicket(token, verificationOptions(futureStore, NOW_MS - 1)),
    ).resolves.toBe(false);
    expect(futureStore.calls).toHaveLength(0);
  });

  it('rejects validly signed claims with extra, missing, or invalid fields', async () => {
    const valid = decodeClaim(await issueWebSocketTicket(BASE_OPTIONS));
    const { tenantId: _tenantId, ...missingTenant } = valid;
    const invalidClaims: unknown[] = [
      { ...valid, extra: true },
      missingTenant,
      { ...valid, aud: 'vela:invoke' },
      { ...valid, purpose: 'signed-url' },
      { ...valid, issuedAtMs: valid.issuedAtMs + 0.5 },
      { ...valid, expiresAtMs: valid.issuedAtMs + WEBSOCKET_TICKET_MAX_TTL_MS + 1 },
      { ...valid, principal: { ...valid.principal, role: 'admin' } },
      { ...valid, principal: { ...valid.principal, principalType: '' } },
      { ...valid, principal: { ...valid.principal, principalType: 'robot' } },
      { ...valid, gatewayPath: '/rooms/../admin/ws' },
      { ...valid, nonce: '' },
    ];

    for (const invalid of invalidClaims) {
      const token = await signForeignClaim(invalid);
      await expect(
        verifyAndConsumeWebSocketTicket(token, verificationOptions(new AtomicTestNonceStore())),
      ).resolves.toBe(false);
    }
  });

  it('fails closed when the nonce store throws or returns a non-boolean verdict', async () => {
    const token = await issueWebSocketTicket(BASE_OPTIONS);
    const throwingStore: WebSocketTicketNonceStore = {
      claim: async () => {
        throw new Error('store unavailable');
      },
    };
    const malformedStore = {
      claim: async () => 'true',
    } as unknown as WebSocketTicketNonceStore;

    await expect(
      verifyAndConsumeWebSocketTicket(token, verificationOptions(throwingStore)),
    ).resolves.toBe(false);
    await expect(
      verifyAndConsumeWebSocketTicket(token, verificationOptions(malformedStore)),
    ).resolves.toBe(false);
  });

  it('requires secure bounded issuance inputs and a lifetime no longer than 30 seconds', async () => {
    const invalidOptions: IssueWebSocketTicketOptions[] = [
      { ...BASE_OPTIONS, secret: '' },
      { ...BASE_OPTIONS, secret: '   ' },
      { ...BASE_OPTIONS, gatewayPath: 'rooms/:room/ws' },
      { ...BASE_OPTIONS, gatewayPath: '/rooms/../admin/ws' },
      { ...BASE_OPTIONS, room: 'bad\u0000room' },
      { ...BASE_OPTIONS, tenantId: '' },
      { ...BASE_OPTIONS, principal: { ...BASE_OPTIONS.principal, subject: 'x'.repeat(513) } },
      { ...BASE_OPTIONS, ttlMs: 0 },
      { ...BASE_OPTIONS, ttlMs: WEBSOCKET_TICKET_MAX_TTL_MS + 1 },
    ];

    for (const invalid of invalidOptions) {
      await expect(issueWebSocketTicket(invalid)).rejects.toBeInstanceOf(TypeError);
    }
  });
});

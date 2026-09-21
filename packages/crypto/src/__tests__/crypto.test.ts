import { describe, it, expect, vi } from 'vitest';
import {
  CryptoService,
  LocalKeyRing,
  CryptoError,
  ENVELOPE_PREFIX,
  decodeBase64Url,
  encodeBase64Url,
} from '../index';
import { encryptFile, decryptFile, encryptToR2 } from '../files/index';
import { fieldProtection } from '../fields/index';
import { TenantCrypto } from '../tenant/index';
import { TenantService, MemoryTenantRegistryStore } from '@velajs/tenant';
const old = crypto.getRandomValues(new Uint8Array(32)),
  next = crypto.getRandomValues(new Uint8Array(32));
const provider = await LocalKeyRing.fromRaw('old', { old });
const service = new CryptoService(provider);
const context = {
  namespace: 'app:prod',
  tenantId: 'a',
  purpose: 'secret',
  caller: { document: '42' },
};
const cipher = service.forContext(context),
  encoder = new TextEncoder();
function source(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(value);
      c.close();
    },
  });
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    length += next.value.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function frames(bytes: Uint8Array): Uint8Array[] {
  const headerEnd = 11 + new DataView(bytes.buffer).getUint32(7),
    parts = [bytes.slice(0, headerEnd)];
  let offset = headerEnd;
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer).getUint32(offset + 5);
    parts.push(bytes.slice(offset, offset + 9 + length));
    offset += 9 + length;
  }
  return parts;
}
function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
describe('authenticated encryption', () => {
  it('snapshots input before asynchronous key lookup and leaves invalid streams unlocked', async () => {
    const ready = Promise.withResolvers<void>();
    const delayed = new CryptoService({
      async current() {
        await ready.promise;
        return provider.current();
      },
      get: (id) => provider.get(id),
    });
    const input = encoder.encode('original');
    const encrypted = delayed.encrypt(input, context);
    input.fill(0);
    ready.resolve();
    expect(await service.decryptText(await encrypted, context)).toBe('original');
    const stream = source(new Uint8Array());
    expect(() => decryptFile(stream, cipher, { maxChunkSize: 0 })).toThrow('chunk limit');
    expect(stream.locked).toBe(false);
  });
  it('roundtrips with randomized data keys and binds every context component', async () => {
    const first = await service.encryptText('private', context),
      second = await service.encryptText('private', context);
    expect(first).not.toBe(second);
    expect(await service.decryptText(first, context)).toBe('private');
    for (const wrong of [
      { ...context, tenantId: 'b' },
      { ...context, purpose: 'other' },
      { ...context, namespace: 'app:test' },
      { ...context, caller: { document: '43' } },
    ])
      await expect(service.decryptText(first, wrong)).rejects.toThrow(CryptoError);
    await expect(
      new CryptoService(await LocalKeyRing.fromRaw('old', { old: next })).decrypt(first, context),
    ).rejects.toThrow();
  });
  it('authenticates repeated protection, rejects malformed/tampered envelopes and rotates keys', async () => {
    const value = await service.protect('private', context);
    expect(await service.protect(value, context)).toBe(value);
    await expect(service.protect(value, { ...context, tenantId: 'b' })).rejects.toThrow();
    const data = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(value.slice(ENVELOPE_PREFIX.length))),
    );
    data.iv = encodeBase64Url(new Uint8Array(12));
    await expect(
      service.decrypt(
        ENVELOPE_PREFIX + encodeBase64Url(encoder.encode(JSON.stringify(data))),
        context,
      ),
    ).rejects.toThrow();
    for (const bad of ['vela:enc:9:any', 'vela:enc:1:%', 'vela:enc:1:e30', value.slice(0, -5)])
      await expect(service.decrypt(bad, context)).rejects.toThrow();
    const rotating = new CryptoService(await LocalKeyRing.fromRaw('next', { old, next })),
      migrated = await rotating.reencrypt(value, context);
    expect(
      await new CryptoService(await LocalKeyRing.fromRaw('next', { next })).decryptText(
        migrated,
        context,
      ),
    ).toBe('private');
    await expect(
      new CryptoService(await LocalKeyRing.fromRaw('next', { next })).decryptText(value, context),
    ).rejects.toThrow();
  });
  it('derives tenant authority and reveals fields only at an authorized boundary', async () => {
    const tenants = new TenantService({
      lookup: new MemoryTenantRegistryStore([
        { id: 'a', name: 'A', status: 'active', revision: 1, settings: {} },
      ]),
      authorize: () => true,
    });
    let retained: ReturnType<TenantCrypto['forPurpose']> | undefined;
    await tenants.run(
      { tenantId: 'a', principal: { issuer: 'test', subject: 'u', principalType: 'user' } },
      async (scope) => {
        const crypto = new TenantCrypto(service, scope, 'app');
        retained = crypto.forPurpose('secret');
        const protection = fieldProtection({
          fields: ['private', 'hidden'],
          cipher: (field) => crypto.forPurpose(field),
          authorizeRead: (field) => field === 'private',
        });
        const protectedRow = await protection.protect({
          id: 1,
          private: { secret: 1 },
          hidden: 'no',
        });
        expect(await protection.protect(protectedRow)).toEqual(protectedRow);
        expect(await protection.reveal(protectedRow)).toEqual({ id: 1, private: { secret: 1 } });
        await expect(
          protection.reveal({ ...protectedRow, private: protectedRow.hidden }),
        ).rejects.toThrow();
      },
    );
    expect(() => retained!.encryptText('late')).toThrow();
  });
});
describe('authenticated file streaming', () => {
  it('streams non-aligned input, empty files and small frames', async () => {
    for (const size of [0, 1, 128, 5000]) {
      const input = crypto.getRandomValues(new Uint8Array(size));
      const encrypted = await collect(await encryptFile(source(input), cipher, { chunkSize: 37 }));
      expect(await collect(decryptFile(source(encrypted), cipher))).toEqual(input);
    }
  });
  it('rejects truncation, reordering, duplication, tampering, trailing bytes and wrong purpose', async () => {
    const encrypted = await collect(
        await encryptFile(source(encoder.encode('abcdefghijklmnopqrstuvwxyz')), cipher, {
          chunkSize: 8,
        }),
      ),
      parts = frames(encrypted);
    const tampered = encrypted.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    for (const bytes of [
      encrypted.slice(0, -1),
      join(parts.slice(0, -1)),
      join([parts[0]!, parts[2]!, parts[1]!, ...parts.slice(3)]),
      join([parts[0]!, parts[1]!, ...parts.slice(1)]),
      tampered,
      join([encrypted, new Uint8Array([0])]),
    ])
      await expect(collect(decryptFile(source(bytes), cipher))).rejects.toThrow();
    await expect(
      collect(decryptFile(source(encrypted), service.forContext({ ...context, purpose: 'wrong' }))),
    ).rejects.toThrow();
  });
  it('propagates cancellation and aborts incomplete R2 uploads', async () => {
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(10));
      },
      cancel,
    });
    const encrypted = await encryptFile(input, cipher);
    const reader = encrypted.getReader();
    await reader.read();
    await reader.cancel('stop');
    expect(cancel).toHaveBeenCalled();
    const abort = vi.fn(async () => {}),
      complete = vi.fn(async () => ({}));
    const bucket = {
      createMultipartUpload: async () => ({
        uploadPart: async () => {
          throw new Error('offline');
        },
        abort,
        complete,
      }),
      get: async () => null,
    };
    await expect(encryptToR2(bucket, 'file', source(new Uint8Array(10)), cipher)).rejects.toThrow(
      'offline',
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
});

it('cancels a pending read on abort and cancels plaintext if R2 initiation fails', async () => {
  const stop = new AbortController(),
    cancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({ cancel });
  const stream = await encryptFile(input, cipher, { signal: stop.signal }),
    reader = stream.getReader();
  await reader.read();
  const pending = reader.read();
  stop.abort(Error('stopped'));
  await expect(pending).rejects.toThrow('stopped');
  expect(cancel).toHaveBeenCalledOnce();
  const inputCancel = vi.fn();
  await expect(
    encryptToR2(
      {
        createMultipartUpload: async () => {
          throw Error('init failed');
        },
        get: async () => null,
      },
      'key',
      new ReadableStream({ cancel: inputCancel }),
      cipher,
    ),
  ).rejects.toThrow('init failed');
  expect(inputCancel).toHaveBeenCalledOnce();
});
it('canonicalizes context before ordering keys and rejects canonical collisions', async () => {
  const a = { ...context, caller: { 'e\u0301': 'one', a: 'two' } },
    b = { ...context, caller: { a: 'two', é: 'one' } };
  const encrypted = await service.encryptText('value', a);
  expect(await service.decryptText(encrypted, b)).toBe('value');
  await expect(
    service.encryptText('value', { ...context, caller: { 'e\u0301': 'one', é: 'two' } }),
  ).rejects.toThrow('Duplicate');
});

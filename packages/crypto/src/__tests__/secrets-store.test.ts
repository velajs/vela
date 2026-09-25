import type { SecretsStoreSecret as NativeSecret } from '@cloudflare/workers-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CryptoError, CryptoService, encodeBase64Url } from '../index';
import { SecretsStoreKeyProvider, type SecretsStoreSecret } from '../cloudflare/index';

const material = (byte: number) => encodeBase64Url(new Uint8Array(32).fill(byte));
const secret = (byte: number) => ({ get: vi.fn(async () => material(byte)) });
const context = { namespace: 'documents', purpose: 'content' };

describe('SecretsStoreKeyProvider', () => {
  it('imports nonextractable AES-KW keys, rotates and retains old decrypt keys', async () => {
    const old = secret(1),
      next = secret(2);
    const first = new CryptoService(
      new SecretsStoreKeyProvider({ activeKeyId: 'key-v1', keys: { 'key-v1': old } }),
    );
    const encrypted = await first.encryptText('example', context);
    const provider = new SecretsStoreKeyProvider({
      activeKeyId: 'key-v2',
      keys: { 'key-v1': old, 'key-v2': next },
    });
    const current = await provider.current();
    expect(current.id).toBe('key-v2');
    expect(current.key.extractable).toBe(false);
    expect(current.key.algorithm).toEqual({ name: 'AES-KW', length: 256 });
    expect(current.key.usages).toEqual(['wrapKey', 'unwrapKey']);
    const rotated = new CryptoService(provider);
    expect(await rotated.decryptText(encrypted, context)).toBe('example');
    const updated = await rotated.reencrypt(encrypted, context);
    const retired = new CryptoService(
      new SecretsStoreKeyProvider({ activeKeyId: 'key-v2', keys: { 'key-v2': next } }),
    );
    expect(await retired.decryptText(updated, context)).toBe('example');
    await expect(retired.decryptText(encrypted, context)).rejects.toBeInstanceOf(CryptoError);
  });

  it('copies configuration and isolates the same key ID in different environments', async () => {
    const a = secret(1),
      b = secret(2),
      keys = { v1: a };
    const options = { activeKeyId: 'v1', keys, cacheTtlMs: 60_000 };
    const providerA = new SecretsStoreKeyProvider(options);
    keys.v1 = b;
    options.activeKeyId = 'v2';
    const providerB = new SecretsStoreKeyProvider({
      activeKeyId: 'v1',
      keys: { v1: b },
      cacheTtlMs: 60_000,
    });
    const cipherA = new CryptoService(providerA),
      cipherB = new CryptoService(providerB);
    const value = await cipherA.encryptText('private', context);
    await expect(cipherB.decryptText(value, context)).rejects.toBeInstanceOf(CryptoError);
    expect(await cipherA.decryptText(value, context)).toBe('private');
    expect(providerA.activeKeyId).toBe('v1');
    expect(a.get).toHaveBeenCalledOnce();
    expect(b.get).toHaveBeenCalledOnce();
  });

  it('re-reads by default, avoids reads for unknown IDs and coalesces in-flight reads', async () => {
    const binding = secret(1);
    const provider = new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: { v1: binding } });
    await Promise.all([provider.current(), provider.current(), provider.get('v1')]);
    expect(binding.get).toHaveBeenCalledOnce();
    await provider.current();
    expect(binding.get).toHaveBeenCalledTimes(2);
    expect(await provider.get('unknown')).toBeUndefined();
    expect(binding.get).toHaveBeenCalledTimes(2);
  });

  it('expires cached keys, invalidates explicitly and never serves stale keys on failure', async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const binding = secret(1);
      const provider = new SecretsStoreKeyProvider({
        activeKeyId: 'v1',
        keys: { v1: binding },
        cacheTtlMs: 100,
      });
      await provider.current();
      now = 1099;
      await provider.current();
      expect(binding.get).toHaveBeenCalledOnce();
      now = 1100;
      binding.get.mockRejectedValueOnce(new Error('private-secret'));
      await expect(provider.current()).rejects.toThrow(
        'Secrets Store wrapping key could not be loaded',
      );
      await provider.current();
      expect(binding.get).toHaveBeenCalledTimes(3);
      provider.invalidate('v1');
      await provider.current();
      provider.invalidate();
      await provider.current();
      expect(binding.get).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects changed material for an observed ID after refresh, but permits retry of the original', async () => {
    const binding = secret(1);
    const provider = new SecretsStoreKeyProvider({
      activeKeyId: 'v1',
      keys: { v1: binding },
      cacheTtlMs: 1000,
    });
    await provider.current();
    binding.get.mockResolvedValueOnce(material(2));
    provider.invalidate();
    await expect(provider.current()).rejects.toBeInstanceOf(CryptoError);
    await expect(provider.current()).resolves.toMatchObject({ id: 'v1' });
  });

  it('does not let a rejected old load evict a newer load after invalidation', async () => {
    let rejectOld!: (error: Error) => void;
    const old = new Promise<string>((_resolve, reject) => {
      rejectOld = reject;
    });
    const binding = secret(1);
    binding.get.mockReturnValueOnce(old);
    const provider = new SecretsStoreKeyProvider({
      activeKeyId: 'v1',
      keys: { v1: binding },
      cacheTtlMs: 1000,
    });
    const first = provider.current();
    const rejection = expect(first).rejects.toBeInstanceOf(CryptoError);
    provider.invalidate();
    await provider.current();
    rejectOld(new Error('private secret'));
    await rejection;
    await provider.current();
    expect(binding.get).toHaveBeenCalledTimes(2);
  });

  it.each(['', ' v1', 'v1 ', 'line\nbreak', 'x'.repeat(129), 'é', 'e\u0301'])(
    'rejects noncanonical key ID %j',
    (id) => {
      expect(
        () => new SecretsStoreKeyProvider({ activeKeyId: id, keys: { [id]: secret(1) } }),
      ).toThrow('Invalid immutable wrapping key ID');
    },
  );
  it.each([-1, Infinity, NaN, 1.5])('rejects cache TTL %s', (cacheTtlMs) => {
    expect(
      () => new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: { v1: secret(1) }, cacheTtlMs }),
    ).toThrow('Invalid key cache lifetime');
  });
  it('requires an active binding', () => {
    expect(() => new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: {} })).toThrow(
      'Active wrapping key is missing',
    );
  });
  it.each([
    '',
    'secret-value',
    material(1) + '=',
    material(1) + '\n',
    encodeBase64Url(new Uint8Array(31)),
    encodeBase64Url(new Uint8Array(33)),
    'x'.repeat(100_000),
    null,
    42,
  ])('rejects malformed material without retaining it or a cause (%#)', async (value) => {
    const binding = { get: vi.fn(async () => value as string) };
    const provider = new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: { v1: binding } });
    try {
      await provider.current();
      expect.fail('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).message).toBe('Secrets Store wrapping key could not be loaded');
      expect((error as Error).cause).toBeUndefined();
    }
    binding.get.mockResolvedValueOnce(material(1));
    await expect(provider.current()).resolves.toMatchObject({ id: 'v1' });
  });
  it('sanitizes binding errors, including nested causes, and permits retries', async () => {
    const binding = secret(1);
    binding.get.mockRejectedValueOnce(new Error('raw-secret', { cause: { token: 'raw-secret' } }));
    const provider = new SecretsStoreKeyProvider({ activeKeyId: 'v1', keys: { v1: binding } });
    const error = await provider.current().catch((error: unknown) => error);
    expect(String(error)).not.toContain('raw-secret');
    expect((error as Error).cause).toBeUndefined();
    await expect(provider.current()).resolves.toMatchObject({ id: 'v1' });
  });
});

it('accepts the native Secrets Store binding structurally', () => {
  expectTypeOf<NativeSecret>().toExtend<SecretsStoreSecret>();
});

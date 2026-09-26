import { describe, expect, it } from 'vitest';
import { Module, VelaFactory } from '@velajs/vela';
import { CryptoError, LocalKeyRing } from '../index';
import { CRYPTO_SERVICE, CryptoModule } from '../vela';

describe('CryptoModule registration ownership', () => {
  it('isolates independent registrations and shares a reused module definition', async () => {
    const leftProvider = await LocalKeyRing.fromRaw('key', {
      key: crypto.getRandomValues(new Uint8Array(32)),
    });
    const rightProvider = await LocalKeyRing.fromRaw('key', {
      key: crypto.getRandomValues(new Uint8Array(32)),
    });
    const first = CryptoModule.register({ provider: leftProvider });
    const second = CryptoModule.registerAsync({ useFactory: () => ({ provider: rightProvider }) });
    class App {}
    Module({ imports: [first, first, second] })(App);
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    try {
      const owners = app.getContainer().getOwnerModuleIds(CRYPTO_SERVICE);
      expect(owners).toHaveLength(2);
      const left = app.getContainer().resolve(CRYPTO_SERVICE, owners[0]);
      const right = app.getContainer().resolve(CRYPTO_SERVICE, owners[1]);
      const context = { namespace: 'module-test', purpose: 'message' };
      const encrypted = await left.forContext(context).encryptText('private');
      expect(await left.forContext(context).decryptText(encrypted)).toBe('private');
      await expect(right.forContext(context).decryptText(encrypted)).rejects.toBeInstanceOf(
        CryptoError,
      );
    } finally {
      await app.dispose();
    }
  });
});

import type { TenantContextReader } from '@velajs/tenant';
import { CryptoService, type BinaryCipher, type TextCipher } from '../index';
/** Ordinary methods derive tenant authority on every call and reject admin scopes. */
export class TenantCrypto {
  constructor(
    private readonly service: CryptoService,
    private readonly tenant: TenantContextReader,
    private readonly namespace: string,
  ) {}
  forPurpose(
    purpose: string,
    caller: Readonly<Record<string, string>> = {},
  ): BinaryCipher & TextCipher {
    const context = () => ({
      namespace: this.namespace,
      purpose,
      caller,
      tenantId: this.tenant.requireTenant().id,
    });
    return {
      encrypt: (value) => this.service.encrypt(value, context()),
      decrypt: (value) => this.service.decrypt(value, context()),
      encryptText: (value) => this.service.encryptText(value, context()),
      decryptText: (value) => this.service.decryptText(value, context()),
      protect: (value) => this.service.protect(value, context()),
    };
  }
}

import { InjectionToken, defineModule, defineProvider } from '@velajs/vela';
import { CryptoService, type KeyProvider } from '../index';
export const CRYPTO_SERVICE = new InjectionToken<CryptoService>('vela.crypto');
export interface CryptoModuleOptions {
  provider: KeyProvider;
  maxPlaintextBytes?: number;
}
const { ConfigurableModuleClass } = defineModule<CryptoModuleOptions>({
  name: 'Crypto',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(CRYPTO_SERVICE, {
        inject: [OPTIONS],
        useFactory: (options) => new CryptoService(options.provider, options),
      }),
    ],
    exports: [CRYPTO_SERVICE],
  }),
});
export class CryptoModule extends ConfigurableModuleClass {}

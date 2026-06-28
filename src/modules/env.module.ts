import type { DynamicModule } from '@velajs/vela';
import { EnvRef } from '../env-ref';
import { EnvService } from '../services/env.service';
import { ENV_REF } from '../tokens';

/**
 * Provides {@link EnvService} GLOBALLY so any module's provider factories can
 * `inject: [EnvService]`. Register once on the root module:
 *
 * ```ts
 * @Module({ imports: [EnvModule.forRoot(), AuthModule.forRootAsync({ ... })] })
 * class AppModule {}
 * ```
 *
 * The {@link EnvRef} it provides is collected and initialized by
 * createCloudflareApp's binding-init middleware on the first request (the
 * factory passes it the full `env`, not a single binding).
 */
export class EnvModule {
  static forRoot(): DynamicModule {
    const ref = new EnvRef();
    return {
      module: EnvModule,
      global: true,
      providers: [{ provide: ENV_REF, useValue: ref }, EnvService],
      exports: [EnvService, ENV_REF],
    };
  }
}

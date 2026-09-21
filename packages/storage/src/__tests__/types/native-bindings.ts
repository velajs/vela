// Compiled with Workers globals, matching a wrangler-generated environment.
import { r2Driver } from '../../drivers/r2';
import { r2HybridDriver } from '../../drivers/r2-http';
import { createStorage } from '../../storage.facade';
import { cache, compose, retry } from '../../middleware';

export function verifyNativeBindings(env: { FILES: R2Bucket }): void {
  const native = createStorage({
    driver: compose(r2Driver({ bucket: env.FILES }), cache(), retry()),
  });
  const exact: R2Bucket = native.raw;
  const conditional = native.raw.get('key', { onlyIf: { etagMatches: 'e' } });
  const hybrid: R2Bucket = r2HybridDriver({
    binding: env.FILES,
    bucket: 'uploads',
    accountId: 'a',
    accessKeyId: 'k',
    secretAccessKey: 's',
  }).raw;
  // @ts-expect-error Native bindings do not gain nonexistent methods.
  native.raw.missingNativeMethod();
  void [exact, conditional, hybrid];
}

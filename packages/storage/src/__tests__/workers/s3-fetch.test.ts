import { describe, expect, it } from 'vitest';
import { createStorage } from '../../index';
import { s3Driver } from '../../drivers/s3';

// workerd rejects the platform fetch when it is called with a receiver other
// than the global scope ("Illegal invocation"); Node accepts it, so only a
// Workers-runtime test catches a regression.
describe('s3Driver under workerd (platform fetch)', () => {
  it('invokes the global fetch without a receiver', async () => {
    const storage = createStorage({
      driver: s3Driver({
        // Nothing listens here: the request must fail in the network layer.
        endpoint: 'http://127.0.0.1:9',
        region: 'us-east-1',
        bucket: 'bucket',
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        forcePathStyle: true,
      }),
    });

    const error = await storage.upload('a.txt', 'hello', { retries: 0 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const messages = [error, (error as Error).cause].map((item) =>
      item instanceof Error ? item.message : String(item),
    );
    expect(messages.join(' ')).not.toMatch(/Illegal invocation/);
  });
});

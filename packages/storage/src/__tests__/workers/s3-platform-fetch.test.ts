import { describe, expect, it } from 'vitest';
import { StorageError, createStorage } from '../../index';
import { s3Driver } from '../../drivers/s3';

/** Every message on an error's `cause` chain. */
function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && messages.length < 8) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

// workerd rejects the platform fetch when it is called with a receiver other
// than the global scope ("Illegal invocation"). Node accepts such calls, so
// only a Workers-runtime test observes the regression.
describe('s3Driver on the platform fetch (workerd)', () => {
  it('sends requests through the global fetch without a receiver', async () => {
    const storage = createStorage({
      driver: s3Driver({
        // Nothing listens on the discard port: the request must reach the
        // network layer and fail there.
        endpoint: 'http://127.0.0.1:9',
        region: 'us-east-1',
        bucket: 'bucket',
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        forcePathStyle: true,
      }),
    });

    const failure = await storage.upload('a.txt', 'hello', { retries: 0 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(StorageError);
    expect(causeMessages(failure).join(' | ')).not.toMatch(/Illegal invocation/i);
  });
});

import { Container } from '../container/container';
import { InjectionToken } from '../container/types';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { runInEntrypointScope } from '../entrypoint/execution-scope';

export async function verifyExecutionInference(container: Container): Promise<void> {
  const TOKEN = new InjectionToken<{ value: string }>('entrypoint');
  const value = await resolveEntrypoint(container, { token: TOKEN, moduleId: 'owner' });
  const text: string = value.value;
  // @ts-expect-error Resolution type follows the token, never a caller assertion.
  const number: number = value.value;
  const result: number = await runInEntrypointScope(container, (_scope, lifetime) => {
    lifetime.defer(async () => text);
    lifetime.waitUntil(Promise.resolve(text));
    // @ts-expect-error Cancellation carries an AbortSignal, not an arbitrary string.
    const invalid: string = lifetime.signal;
    void invalid;
    return 42;
  });
  void [number, result];
}

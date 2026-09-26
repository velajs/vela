import { describe, expect, it } from 'vitest';
import worker from '../../../../../apps/graphql-worker/src/index';

describe('native Worker GraphQL', () => {
  it('serves the example without nodejs_compat and preserves environment ownership', async () => {
    const request = () =>
      new Request('https://example.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ a:greet(name:" Ada ") b:greet(name:"Ada") }' }),
      });
    const context = {
      props: {},
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException() {},
    };
    const responses = await Promise.all([
      worker.fetch(request(), { APP_LABEL: 'one' }, context),
      worker.fetch(request(), { APP_LABEL: 'two' }, context),
    ]);
    expect(await responses[0]!.json()).toEqual({
      data: { a: 'one: hello, Ada', b: 'one: hello, Ada' },
    });
    expect(await responses[1]!.json()).toEqual({
      data: { a: 'two: hello, Ada', b: 'two: hello, Ada' },
    });
  });
});

import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createRpcClient, RpcError } from '../../index';
import { greet } from '../../../examples/contracts';

it('calls an actual Worker through a Fetcher with the portable typed client', async () => {
  const client = createRpcClient({ url: 'https://service.test/rpc', fetch: SELF });
  expect(await client.call(greet, { name: 'Workers' })).toEqual({ message: 'Hello, Workers!' });
});
it('validates procedure input in workerd and preserves correlated failure envelopes', async () => {
  const client = createRpcClient({ url: 'https://service.test/rpc', fetch: SELF });
  await expect(client.call(greet, { name: '' })).rejects.toBeInstanceOf(RpcError);
});

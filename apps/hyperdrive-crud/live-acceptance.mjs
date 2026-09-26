import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Only touches caller-confirmed, pre-existing synthetic resources. Never deploys. */
export async function runAcceptance(options, fetcher = fetch) {
  if (options.confirm !== 'pre-existing-synthetic-cache-disabled')
    throw new Error(
      'Confirm a pre-existing synthetic Worker and cache-disabled Hyperdrive binding',
    );
  if (typeof options.token !== 'string' || !options.token.trim())
    throw new Error('An access token is required');
  const base = new URL(options.url);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Supply an HTTPS Worker origin without credentials, path, query or fragment');
  const ids = Array.from({ length: 3 }, () => `acceptance-${crypto.randomUUID()}`);
  const request = async (path, method = 'GET', body) => {
    const response = await fetcher(new URL(path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response;
  };
  let primary;
  try {
    const created = await Promise.allSettled(
      ids.map(async (id) => {
        const response = await request('/items', 'POST', { id, title: 'before' });
        await response.arrayBuffer();
        assert.equal(response.status, 201);
      }),
    );
    const failed = created.filter((result) => result.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Concurrent creation failed',
      );
    for (const id of ids) {
      const before = await request(`/items/${id}`);
      assert.equal(before.status, 200);
      assert.deepEqual((await before.json()).result, { id, title: 'before' });
      const changed = await request(`/items/${id}`, 'PATCH', { title: 'after' });
      assert.equal(changed.status, 200);
      await changed.arrayBuffer();
      const after = await request(`/items/${id}`);
      assert.equal(after.status, 200);
      assert.deepEqual((await after.json()).result, { id, title: 'after' });
    }
  } catch (error) {
    primary = error;
  }
  const cleanup = [];
  // Client waits have settled. A timed-out remote write can still commit later;
  // cleanup is best-effort and failure diagnostics retain IDs for reconciliation.
  for (const id of ids) {
    try {
      const response = await request(`/items/${id}`, 'DELETE');
      assert.ok(
        response.status === 200 || response.status === 404,
        `Cleanup failed (${response.status})`,
      );
      await response.arrayBuffer();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (primary || cleanup.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanup],
      `Hyperdrive acceptance failed; reconcile synthetic IDs: ${ids.join(', ')}`,
    );
  return {
    status: 'passed',
    requests: 15,
    concurrentCreates: 3,
    freshness:
      'Immediate read-after-write passed; cache-disabled configuration is an operator assertion',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    await runAcceptance({
      url: process.env.VELA_HYPERDRIVE_ACCEPTANCE_URL,
      token: process.env.VELA_HYPERDRIVE_ACCEPTANCE_TOKEN,
      confirm: process.env.VELA_HYPERDRIVE_ACCEPTANCE_CONFIRM,
    }),
  );
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { consumerTsconfig } from '../../scripts/graphql-consumer.mjs';

// The packed GraphQL consumer type-checks and bundles the example Worker's
// source, so it must compile that source's decorators the way the app does.
test('the packed GraphQL consumer compiles decorators like the example app', async () => {
  const app = JSON.parse(
    await readFile(new URL('../../apps/graphql-worker/tsconfig.json', import.meta.url), 'utf8'),
  );
  for (const option of ['experimentalDecorators', 'emitDecoratorMetadata']) {
    assert.equal(app.compilerOptions[option], true, `the example app sets ${option}`);
    assert.equal(consumerTsconfig.compilerOptions[option], true, `the consumer sets ${option}`);
  }
});

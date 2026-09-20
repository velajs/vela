import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationOrder, waitForIntegrity } from '../../scripts/release-publish.mjs';

const entry = { name: '@velajs/example', version: '1.22.0', integrity: 'sha512-tested' };
test('npm may accept a version before it is visible; wait without resubmitting', async () => {
  let reads = 0;
  let pauses = 0;
  await waitForIntegrity(entry, () => (++reads < 3 ? undefined : entry.integrity), {
    attempts: 3,
    pause: async () => {
      pauses++;
    },
  });
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
});
test('a visible different archive fails immediately', async () => {
  await assert.rejects(
    waitForIntegrity(entry, () => 'sha512-other', {
      pause: async () => assert.fail('must not retry a collision'),
    }),
    /Registry collision/,
  );
});
test('a processing timeout preserves an actionable retry error', async () => {
  await assert.rejects(
    waitForIntegrity(entry, () => undefined, { attempts: 2, pause: async () => {} }),
    /retain these artifacts/,
  );
});
test('publication puts dependencies and peers before their consumers', () => {
  const ordered = publicationOrder([
    { name: 'app', dependencies: ['core', 'external'] },
    { name: 'core', dependencies: ['errors'] },
    { name: 'errors', dependencies: [] },
  ]);
  assert.deepEqual(
    ordered.map((item) => item.name),
    ['errors', 'core', 'app'],
  );
  assert.throws(
    () =>
      publicationOrder([
        { name: 'a', dependencies: ['b'] },
        { name: 'b', dependencies: ['a'] },
      ]),
    /cycle/,
  );
  assert.throws(
    () =>
      publicationOrder([
        { name: 'a', dependencies: [] },
        { name: 'a', dependencies: [] },
      ]),
    /Duplicate/,
  );
});

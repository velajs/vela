import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertV1Releases } from '../../scripts/release-line.mjs';

test('minor, patch and prerelease versions stay on the active 1.x line', () => {
  assert.doesNotThrow(() =>
    assertV1Releases(
      ['1.28.0', '1.28.1', '1.29.0-next.0'].map((version) => ({
        name: '@velajs/example',
        version,
      })),
    ),
  );
});

test('reject an out-of-line version before applying a Changesets release plan', () => {
  for (const version of ['0.9.0', '2.0.0', '3.0.0', undefined])
    assert.throws(
      () =>
        assertV1Releases([
          { name: '@velajs/vela', version: '1.28.0' },
          { name: '@velajs/cloudflare', version },
        ]),
      /@velajs\/cloudflare@.*Vela stays on 1.x; use a minor changeset/,
    );
});

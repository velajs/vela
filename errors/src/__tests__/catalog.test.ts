import { describe, expect, it } from 'vitest';
import { composeCatalogs, CORE_CATALOG, defineErrorCatalog, STATUS_TO_CODE } from '../catalog';
import { VelaError } from '../error';

describe('defineErrorCatalog', () => {
  const storage = defineErrorCatalog({
    bucket_missing: { status: 404, title: 'Bucket not found', hint: 'Check wrangler bindings.' },
    upstream_error: { status: 502, title: 'Upstream provider failed', internal: true },
  });

  it('derives a typed thrower with catalog defaults', () => {
    const err = storage.error('bucket_missing', { message: 'no bucket "media"' });
    expect(err).toBeInstanceOf(VelaError);
    expect(err.status).toBe(404);
    expect(err.hint).toBe('Check wrangler bindings.');
  });

  it('exposes entries and lookup', () => {
    expect(storage.has('upstream_error')).toBe(true);
    expect(storage.get('upstream_error')?.internal).toBe(true);
    expect(storage.get('nope')).toBeUndefined();
  });
});

describe('composeCatalogs', () => {
  it('merges disjoint catalogs', () => {
    const extra = defineErrorCatalog({ order_expired: { status: 410, title: 'Order expired' } });
    const composed = composeCatalogs(CORE_CATALOG, extra);
    expect(composed.has('not_found')).toBe(true);
    expect(composed.has('order_expired')).toBe(true);
  });

  it('throws on duplicate codes at compose time', () => {
    const dup = defineErrorCatalog({ not_found: { status: 404, title: 'shadow' } });
    expect(() => composeCatalogs(CORE_CATALOG, dup)).toThrow(/duplicate error code/i);
  });
});

describe('prototype-key safety', () => {
  const catalog = defineErrorCatalog({ real_code: { status: 400, title: 'Real' } });

  it('has/get do not walk Object.prototype', () => {
    expect(catalog.has('toString')).toBe(false);
    expect(catalog.get('toString')).toBeUndefined();
    expect(catalog.has('real_code')).toBe(true);
  });

  it('composeCatalogs does not false-positive on prototype keys', () => {
    const proto = defineErrorCatalog({ constructor: { status: 400, title: 'Ctor-named code' } });
    const composed = composeCatalogs(catalog, proto);
    expect(composed.has('constructor')).toBe(true);
  });
});

describe('STATUS_TO_CODE', () => {
  it('maps every core status back to its code', () => {
    expect(STATUS_TO_CODE[404]).toBe('not_found');
    expect(STATUS_TO_CODE[500]).toBe('internal');
  });
});

import { describe, it, expect } from 'vitest';
import { TestResponse } from '../http/test-response.js';

function jsonResponse(body: unknown, init?: ResponseInit): TestResponse {
  const status = init?.status ?? 200;
  // 204/304 forbid a body per the fetch spec.
  const hasBody = status !== 204 && status !== 304;
  return new TestResponse(
    new Response(hasBody ? JSON.stringify(body) : null, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    }),
  );
}

describe('TestResponse status assertions', () => {
  it('assertOk / assertStatus pass on 200 and chain', () => {
    const res = jsonResponse({}, { status: 200 });
    expect(res.assertOk()).toBe(res);
    expect(res.assertStatus(200)).toBe(res);
  });

  it('assertCreated passes on 201', () => {
    jsonResponse({}, { status: 201 }).assertCreated();
  });

  it('assertStatus throws with a helpful message on mismatch', () => {
    const res = jsonResponse({}, { status: 404 });
    expect(() => res.assertOk()).toThrow(/Expected status 200, got 404/);
  });

  it('assertSuccessful covers the 2xx range', () => {
    jsonResponse({}, { status: 204 }).assertNoContent().assertSuccessful();
    expect(() => jsonResponse({}, { status: 500 }).assertSuccessful()).toThrow();
  });
});

describe('TestResponse JSON assertions', () => {
  const res = () =>
    jsonResponse({
      data: { id: 1, name: 'A', tags: ['x', 'y'], message: 'hello world', deletedAt: null },
    });

  it('assertJson matches top-level keys', async () => {
    await jsonResponse({ ok: true, n: 2 }).assertJson({ ok: true, n: 2 });
  });

  it('assertJsonPath reads deep values', async () => {
    await res().assertJsonPath('data.name', 'A');
  });

  it('assertJsonPath throws on mismatch', async () => {
    await expect(res().assertJsonPath('data.name', 'B')).rejects.toThrow(
      /Expected JSON path "data.name"/,
    );
  });

  it('assertJsonPaths batch-asserts', async () => {
    await res().assertJsonPaths({ 'data.id': 1, 'data.name': 'A' });
  });

  it('assertJsonStructure checks top-level keys', async () => {
    await jsonResponse({ a: 1, b: 2 }).assertJsonStructure(['a', 'b']);
  });

  it('assertJsonPathExists distinguishes null from missing', async () => {
    await res().assertJsonPathExists('data.deletedAt');
    await res().assertJsonPathMissing('data.email');
  });

  it('assertJsonPathMatches runs a predicate', async () => {
    await res().assertJsonPathMatches('data.id', (v) => typeof v === 'number');
  });

  it('assertJsonPathContains checks substrings', async () => {
    await res().assertJsonPathContains('data.message', 'world');
  });

  it('assertJsonPathIncludes and assertJsonPathCount work on arrays', async () => {
    await res().assertJsonPathIncludes('data.tags', 'x');
    await res().assertJsonPathCount('data.tags', 2);
  });

  it('json() is memoized and re-readable', async () => {
    const r = res();
    const first = await r.json();
    const second = await r.json();
    expect(first).toBe(second);
  });
});

describe('TestResponse header assertions', () => {
  it('assertHeader checks presence and value', () => {
    const res = jsonResponse({}, { headers: { 'X-Custom': 'yes' } });
    res.assertHeader('X-Custom').assertHeader('X-Custom', 'yes');
  });

  it('assertHeader throws when value differs', () => {
    const res = jsonResponse({}, { headers: { 'X-Custom': 'yes' } });
    expect(() => res.assertHeader('X-Custom', 'no')).toThrow();
  });

  it('assertHeaderMissing passes when absent', () => {
    jsonResponse({}).assertHeaderMissing('X-Absent');
  });
});

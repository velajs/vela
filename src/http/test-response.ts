// Ported from @stratal/testing (MIT, © Temitayo Fadojutimi), minus Macroable —
// vela has no Macroable, so TestResponse is a plain class.
import { expect } from 'vitest';
import { getValueAtPath, hasValueAtPath } from './path-utils.js';

/**
 * TestResponse
 *
 * Wraps a `Response` with fluent, chainable assertions. Synchronous status /
 * header assertions return `this`; JSON assertions (which must read the body)
 * return `Promise<this>`.
 *
 * @example
 * ```ts
 * const res = await module.http.get('/users/1').send();
 * res.assertOk();
 * await res.assertJsonPath('data.id', 1);
 * ```
 */
export class TestResponse {
  private jsonData: unknown = null;
  private textData: string | null = null;

  constructor(private readonly response: Response) {}

  /** The raw `Response`. */
  get raw(): Response {
    return this.response;
  }

  /** The response status code. */
  get status(): number {
    return this.response.status;
  }

  /** The response headers. */
  get headers(): Headers {
    return this.response.headers;
  }

  /** Parse (and cache) the response body as JSON. */
  async json<T = unknown>(): Promise<T> {
    if (this.jsonData === null) {
      this.jsonData = await this.response.clone().json();
    }
    return this.jsonData as T;
  }

  /** Read (and cache) the response body as text. */
  async text(): Promise<string> {
    this.textData ??= await this.response.clone().text();
    return this.textData;
  }

  // ============================================================
  // Status assertions
  // ============================================================

  /** Assert status is 200 OK. */
  assertOk(): this {
    return this.assertStatus(200);
  }

  /** Assert status is 201 Created. */
  assertCreated(): this {
    return this.assertStatus(201);
  }

  /** Assert status is 204 No Content. */
  assertNoContent(): this {
    return this.assertStatus(204);
  }

  /** Assert status is 400 Bad Request. */
  assertBadRequest(): this {
    return this.assertStatus(400);
  }

  /** Assert status is 401 Unauthorized. */
  assertUnauthorized(): this {
    return this.assertStatus(401);
  }

  /** Assert status is 403 Forbidden. */
  assertForbidden(): this {
    return this.assertStatus(403);
  }

  /** Assert status is 404 Not Found. */
  assertNotFound(): this {
    return this.assertStatus(404);
  }

  /** Assert status is 422 Unprocessable Entity. */
  assertUnprocessable(): this {
    return this.assertStatus(422);
  }

  /** Assert status is 500 Internal Server Error. */
  assertServerError(): this {
    return this.assertStatus(500);
  }

  /** Assert the response has the given status code. */
  assertStatus(expected: number): this {
    expect(
      this.response.status,
      `Expected status ${expected}, got ${this.response.status}`,
    ).toBe(expected);
    return this;
  }

  /** Assert the status is in the 2xx range. */
  assertSuccessful(): this {
    expect(
      this.response.status >= 200 && this.response.status < 300,
      `Expected successful status (2xx), got ${this.response.status}`,
    ).toBe(true);
    return this;
  }

  // ============================================================
  // JSON assertions
  // ============================================================

  /** Assert each key in `expected` equals the corresponding top-level value. */
  async assertJson(expected: Record<string, unknown>): Promise<this> {
    const actual = await this.json<Record<string, unknown>>();

    for (const [key, value] of Object.entries(expected)) {
      expect(
        actual[key],
        `Expected JSON key "${key}" to be ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`,
      ).toStrictEqual(value);
    }

    return this;
  }

  /** Assert the value at a dot-notation path equals `expected`. */
  async assertJsonPath(path: string, expected: unknown): Promise<this> {
    const json = await this.json();
    const actual = getValueAtPath(json, path);

    expect(
      actual,
      `Expected JSON path "${path}" to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    ).toStrictEqual(expected);

    return this;
  }

  /** Assert every path/value pair in `expectations` matches (batch assert). */
  async assertJsonPaths(expectations: Record<string, unknown>): Promise<this> {
    const json = await this.json();

    for (const [path, expected] of Object.entries(expectations)) {
      const actual = getValueAtPath(json, path);
      expect(
        actual,
        `Expected JSON path "${path}" to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      ).toStrictEqual(expected);
    }

    return this;
  }

  /** Assert the top-level JSON object has every key in `structure`. */
  async assertJsonStructure(structure: string[]): Promise<this> {
    const json = await this.json<Record<string, unknown>>();

    for (const key of structure) {
      expect(
        key in json,
        `Expected JSON to have key "${key}", got keys: ${JSON.stringify(Object.keys(json))}`,
      ).toBe(true);
    }

    return this;
  }

  /** Assert a path exists (value may be anything, including `null`). */
  async assertJsonPathExists(path: string): Promise<this> {
    const json = await this.json();

    expect(hasValueAtPath(json, path), `Expected JSON path "${path}" to exist`).toBe(true);

    return this;
  }

  /** Assert a path does not exist. */
  async assertJsonPathMissing(path: string): Promise<this> {
    const json = await this.json();

    expect(hasValueAtPath(json, path), `Expected JSON path "${path}" to not exist`).toBe(false);

    return this;
  }

  /** Assert the value at a path satisfies a predicate. */
  async assertJsonPathMatches(
    path: string,
    matcher: (value: unknown) => boolean,
  ): Promise<this> {
    const json = await this.json();
    const value = getValueAtPath(json, path);

    expect(
      matcher(value),
      `Expected JSON path "${path}" to match predicate, got ${JSON.stringify(value)}`,
    ).toBe(true);

    return this;
  }

  /** Assert the string value at a path contains `substring`. */
  async assertJsonPathContains(path: string, substring: string): Promise<this> {
    const json = await this.json();
    const value = getValueAtPath(json, path);

    expect(
      typeof value === 'string',
      `Expected JSON path "${path}" to be a string, got ${typeof value}`,
    ).toBe(true);

    expect(
      (value as string).includes(substring),
      `Expected JSON path "${path}" to contain "${substring}", got "${String(value)}"`,
    ).toBe(true);

    return this;
  }

  /** Assert the array value at a path includes `item`. */
  async assertJsonPathIncludes(path: string, item: unknown): Promise<this> {
    const json = await this.json();
    const value = getValueAtPath(json, path);

    expect(
      Array.isArray(value),
      `Expected JSON path "${path}" to be an array, got ${typeof value}`,
    ).toBe(true);

    expect(
      (value as unknown[]).includes(item),
      `Expected JSON path "${path}" to include ${JSON.stringify(item)}`,
    ).toBe(true);

    return this;
  }

  /** Assert the array value at a path has `count` items. */
  async assertJsonPathCount(path: string, count: number): Promise<this> {
    const json = await this.json();
    const value = getValueAtPath(json, path);

    expect(
      Array.isArray(value),
      `Expected JSON path "${path}" to be an array, got ${typeof value}`,
    ).toBe(true);

    expect(
      (value as unknown[]).length,
      `Expected JSON path "${path}" to have ${count} items, got ${(value as unknown[]).length}`,
    ).toBe(count);

    return this;
  }

  // ============================================================
  // Header assertions
  // ============================================================

  /** Assert a header is present, optionally equal to `expected`. */
  assertHeader(name: string, expected?: string): this {
    const actual = this.response.headers.get(name);

    expect(actual !== null, `Expected header "${name}" to be present`).toBe(true);

    if (expected !== undefined) {
      expect(actual, `Expected header "${name}" to be "${expected}", got "${actual}"`).toBe(
        expected,
      );
    }

    return this;
  }

  /** Assert a header is absent. */
  assertHeaderMissing(name: string): this {
    const actual = this.response.headers.get(name);

    expect(actual, `Expected header "${name}" to be absent, but got "${actual}"`).toBeNull();

    return this;
  }
}

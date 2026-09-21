import { Context } from 'hono';
import {
  REQUEST_CONTEXT,
  runInEntrypointScope,
  type InferToken,
  type Token,
  type Type,
  type VelaApplication,
} from '@velajs/vela';
import { createRequestContext, setRequestContainer, type Container } from '@velajs/vela/internal';
import { SeederRegistry, type ISeeder } from '@velajs/vela/seeder';
import { expect } from 'vitest';
import type { TestDatabase } from './db/test-database.js';
import { TestHttpClient } from './http/test-http-client.js';
import { TestSseRequest } from './sse/test-sse-request.js';
import { TestWsRequest } from './ws/test-ws-request.js';

/** A test principal — an opaque object the auth resolver turns into headers. */
export type TestPrincipal = Record<string, unknown>;

/**
 * Turns a principal into request headers (session cookie, bearer token, …).
 * The signature `(module, principal) => Promise<Headers>` is a cross-package
 * contract: sibling packages (e.g. `@velajs/better-auth/testing`) build a
 * resolver against it. Kept generic so `@velajs/testing` needs no auth deps.
 */
export type ActingAsResolver = (
  module: TestingModule,
  principal: TestPrincipal,
) => Promise<Headers>;

type HonoApp = ReturnType<VelaApplication['getHonoApp']>;

/**
 * TestingModule
 *
 * The compiled test harness. Beyond `get`/`createApplication`/`close`, it adds
 * Laravel-flavored ergonomics: a fluent HTTP client, SSE/WS builders, request-
 * scope execution, seeding, and database assertion wrappers.
 *
 * @example
 * ```ts
 * const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
 * await module.http.post('/users').withBody({ name: 'A' }).send()
 *   .then((r) => r.assertCreated());
 * ```
 */
export class TestingModule {
  #http: TestHttpClient | null = null;
  #honoApp: HonoApp | null = null;
  #authResolver: ActingAsResolver | null = null;

  readonly #app: VelaApplication;
  readonly #container: Container;
  readonly #cleanups: Array<() => void | Promise<void>> = [];
  #closing: Promise<void> | undefined;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(app: VelaApplication, container: Container) {
    this.#app = app;
    this.#container = container;
  }

  /** Resolve a provider from the root container. */
  get<const Key extends Token>(token: Key): InferToken<Key> {
    this.#assertOpen();
    return this.#container.resolve(token);
  }

  /** Build (once) and return the underlying application. */
  async createApplication(): Promise<VelaApplication> {
    this.#assertOpen();
    return this.#app;
  }

  /** Lazy fluent HTTP client bound to this module. */
  get http(): TestHttpClient {
    this.#http ??= new TestHttpClient(this);
    return this.#http;
  }

  /** Start an SSE connection builder for `path`. */
  sse(path: string): TestSseRequest {
    return new TestSseRequest(path, this);
  }

  /** Start a WebSocket connection builder for `path` (needs a transport adapter). */
  ws(path: string): TestWsRequest {
    return new TestWsRequest(path, this);
  }

  /**
   * Drive a `Request` through the full Hono pipeline. The Hono app is built
   * once and reused across requests.
   */
  async fetch(...args: Parameters<HonoApp['fetch']>): Promise<Response> {
    const hono = await this.ensureHono();
    return hono.fetch(...args);
  }

  /**
   * Register a default auth resolver used by `actingAs(principal)` when no
   * resolver is passed explicitly.
   */
  setAuthResolver(resolver: ActingAsResolver): this {
    this.#authResolver = resolver;
    return this;
  }

  /** The default auth resolver, if one was registered. */
  getAuthResolver(): ActingAsResolver | null {
    return this.#authResolver;
  }

  /**
   * Run `callback` inside a request-scoped child container seeded with a real
   * RequestContext, so REQUEST-scoped providers (and anything injecting
   * `REQUEST_CONTEXT`) resolve. The child is disposed afterwards.
   */
  runInRequestScope<T>(callback: (container: Container) => T | Promise<T>): Promise<T> {
    this.#assertOpen();
    const operation = this.#runInRequestScope(callback);
    this.#pending.add(operation);
    // Observe completion without creating an unhandled rejected promise.
    void operation.then(
      () => this.#pending.delete(operation),
      () => this.#pending.delete(operation),
    );
    return operation;
  }

  async #runInRequestScope<T>(callback: (container: Container) => T | Promise<T>): Promise<T> {
    return runInEntrypointScope(this.#container, async (child) => {
      const hono = new Context(new Request('http://localhost/'));
      setRequestContainer(hono, child);
      child.setRequestInstance(REQUEST_CONTEXT, createRequestContext(hono));
      return callback(child);
    });
  }

  /**
   * Run the given `@Seeder()` classes, each in its own request scope. Throws if
   * a class is not a registered seeder. Requires `SeederModule` (or the seeders
   * themselves) to be present in the module graph.
   */
  async seed(...SeederClasses: Type<ISeeder>[]): Promise<void> {
    const registry = this.#container.resolve(SeederRegistry);
    const known = new Set<unknown>(registry.list().map((s) => s.target));

    for (const SeederClass of SeederClasses) {
      if (!known.has(SeederClass)) {
        throw new Error(
          `Seeder "${SeederClass.name}" is not registered. Add it to a module's ` +
            'providers or SeederModule.forRoot({ seeders: [...] }).',
        );
      }
      await this.runInRequestScope(async (child) => {
        const instance = child.resolve(SeederClass);
        await instance.run();
      });
    }
  }

  /** Assert a row matching `where` exists in `table` (via a {@link TestDatabase}). */
  async assertDatabaseHas(
    db: TestDatabase,
    table: string,
    where: Record<string, unknown>,
  ): Promise<void> {
    const exists = await db.has(table, where);
    expect(exists, `Expected ${table} to have a row matching ${JSON.stringify(where)}`).toBe(true);
  }

  /** Assert no row matching `where` exists in `table`. */
  async assertDatabaseMissing(
    db: TestDatabase,
    table: string,
    where: Record<string, unknown>,
  ): Promise<void> {
    const exists = await db.has(table, where);
    expect(exists, `Expected ${table} NOT to have a row matching ${JSON.stringify(where)}`).toBe(
      false,
    );
  }

  /** Assert `table` has exactly `expected` rows. */
  async assertDatabaseCount(db: TestDatabase, table: string, expected: number): Promise<void> {
    const actual = await db.count(table);
    expect(actual, `Expected ${table} count ${expected}, got ${actual}`).toBe(expected);
  }

  /** Register a fixture/transport cleanup, awaited in reverse registration order. */
  onClose(cleanup: () => void | Promise<void>): this {
    this.#assertOpen();
    this.#cleanups.push(cleanup);
    return this;
  }

  /** Fully dispose the application and owned transports. Concurrent calls share completion. */
  close(signal?: string): Promise<void> {
    this.#closing ??= Promise.resolve().then(() => this.#dispose(signal));
    return this.#closing;
  }

  async #dispose(signal?: string): Promise<void> {
    const failures: unknown[] = [];
    for (const cleanup of this.#cleanups.splice(0).toReversed()) {
      try {
        // Cleanup order follows reverse fixture acquisition.
        // eslint-disable-next-line no-await-in-loop
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    // Existing scopes may still use singletons. Drain them before closing the root.
    await Promise.allSettled(this.#pending);
    try {
      await this.#app.dispose(signal);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Testing module cleanup failed');
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error('Testing module is closing or closed');
  }

  private async ensureHono(): Promise<HonoApp> {
    this.#assertOpen();
    if (!this.#honoApp) {
      const app = await this.createApplication();
      this.#honoApp = app.getHonoApp();
    }
    return this.#honoApp;
  }
}

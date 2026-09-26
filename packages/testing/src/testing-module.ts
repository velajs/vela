import { Context } from 'hono';
import {
  REQUEST_CONTEXT,
  Scope,
  type Token,
  type Type,
  type VelaApplication,
  type VelaEnv,
} from '@velajs/vela';
import {
  createExecutionScope,
  describeToken,
  runInEntrypointScope,
  type ExecutionScope,
  type InferToken,
} from '@velajs/vela/module-kit';
import { createRequestContext, setRequestContainer } from '@velajs/vela/internal';
import type { Container } from '@velajs/vela/module-kit';
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

/** The synthetic request a test request scope is seeded with. */
export interface TestRequestInit extends RequestInit {
  /** Absolute request URL; defaults to `http://localhost/`. */
  readonly url?: string | URL;
}

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
  // Request scopes opened by resolveInRequest(), finished by close().
  readonly #openScopes = new Set<ExecutionScope>();

  // The environment seeded at compile time; requests carry it as `c.env`.
  readonly #env: VelaEnv | undefined;

  constructor(app: VelaApplication, container: Container, env?: VelaEnv) {
    this.#app = app;
    this.#container = container;
    this.#env = env;
  }

  /**
   * Resolve a provider from the root container. Request-scoped providers have
   * no root instance; use {@link resolveInRequest} or {@link runInRequestScope}.
   */
  get<const Key extends Token>(token: Key): InferToken<Key> {
    this.#assertOpen();
    if (this.#container.getResolvedScope(token) === Scope.REQUEST) {
      const name = describeToken(token);
      throw new Error(
        `TestingModule.get(${name}) cannot resolve a request-scoped provider. ` +
          `Use \`await module.resolveInRequest(${name})\` or \`module.runInRequestScope()\`.`,
      );
    }
    return this.#container.resolve(token);
  }

  /**
   * Resolve `token` in a fresh request scope seeded with a RequestContext for
   * `init`, so REQUEST-scoped providers (and their request dependencies)
   * resolve. Each call opens its own scope, which stays open until `close()`.
   */
  resolveInRequest<const Key extends Token>(
    token: Key,
    init?: TestRequestInit,
  ): Promise<InferToken<Key>> {
    this.#assertOpen();
    return this.#track(this.#resolveInRequest(token, init));
  }

  async #resolveInRequest<const Key extends Token>(
    token: Key,
    init?: TestRequestInit,
  ): Promise<InferToken<Key>> {
    const scope = createExecutionScope(this.#container);
    this.#openScopes.add(scope);
    try {
      seedRequest(scope.container, init);
      return await scope.container.resolveAsync(token);
    } catch (error) {
      this.#openScopes.delete(scope);
      try {
        await scope.finish();
      } catch (completionError) {
        // Both caught failures are retained in AggregateError.errors.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([error, completionError], 'Resolution and completion failed.', {
          cause: completionError,
        });
      }
      throw error;
    }
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
   * once and reused across requests. Without an explicit `env`, the request
   * carries the environment the module was compiled with (the `env` option)
   * as `c.env`, as a runtime would, so an adapter that binds requests to its
   * environment (such as `cloudflareAdapter({ env })`) accepts them. The HTTP
   * and SSE builders send through here.
   */
  async fetch(
    ...[request, env = this.#env, executionContext]: Parameters<HonoApp['fetch']>
  ): Promise<Response> {
    const hono = await this.ensureHono();
    return hono.fetch(request, env, executionContext);
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
   * RequestContext for `init`, so REQUEST-scoped providers (and anything
   * injecting `REQUEST_CONTEXT`) resolve. The child is disposed afterwards.
   */
  runInRequestScope<T>(
    callback: (container: Container) => T | Promise<T>,
    init?: TestRequestInit,
  ): Promise<T> {
    this.#assertOpen();
    return this.#track(this.#runInRequestScope(callback, init));
  }

  // close() drains tracked operations before finishing scopes and the root.
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    // Observe completion without creating an unhandled rejected promise.
    void operation.then(
      () => this.#pending.delete(operation),
      () => this.#pending.delete(operation),
    );
    return operation;
  }

  async #runInRequestScope<T>(
    callback: (container: Container) => T | Promise<T>,
    init?: TestRequestInit,
  ): Promise<T> {
    return runInEntrypointScope(this.#container, async (child) => {
      seedRequest(child, init);
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
            'providers or SeederModule.forFeature([...]).',
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
    for (const scope of [...this.#openScopes].toReversed()) {
      this.#openScopes.delete(scope);
      try {
        // Later scopes may depend on work an earlier one started.
        // eslint-disable-next-line no-await-in-loop
        await scope.finish();
      } catch (error) {
        failures.push(error);
      }
    }
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

// The production request seeding: a Hono Context bound to the child, and the
// REQUEST_CONTEXT built from it.
function seedRequest(child: Container, init: TestRequestInit = {}): void {
  const { url = 'http://localhost/', ...requestInit } = init;
  const hono = new Context(new Request(url, requestInit));
  setRequestContainer(hono, child);
  child.setRequestInstance(REQUEST_CONTEXT, createRequestContext(hono));
}

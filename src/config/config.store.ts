import { Injectable } from '../container/decorators';
import type { Container } from '../container/container';
import type { Token } from '../container/types';
import type { ConfigSchema } from './config.types';
import type { AnyConfigNamespace } from './register-as';

/** Prototype-pollution guard for dot-notation segments. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function runSchema(schema: ConfigSchema, config: Record<string, unknown>): void {
  if (typeof schema === 'function') {
    schema(config);
    return;
  }
  if (schema && typeof schema.parse === 'function') {
    schema.parse(config);
    return;
  }
  throw new Error('ConfigModule `validateSchema` must be a function or expose a `parse()` method');
}

/**
 * Singleton source of truth for merged configuration.
 *
 * Holds the flat `config` record plus a `namespace → KEY` map. Namespaces are
 * resolved LAZILY — the KEY is pulled from the container on the first read of
 * that namespace and cached — so the store never forces namespace factories to
 * materialize at construction. Resolution uses the synchronous container seam
 * (`resolve`), which stays compatible with lazy modules.
 *
 * The merged shape is `{ ...config, [ns]: value }` — a namespace shadows a flat
 * key of the same name.
 *
 * Constructed via a factory provider in {@link ConfigModule} so it can close
 * over the `load` list and `validateSchema` without extra tokens.
 */
@Injectable()
export class ConfigStore {
  private readonly namespaceKeys = new Map<string, Token>();
  private readonly cache = new Map<string, unknown>();
  private validated = false;
  private validationError: unknown;

  constructor(
    private readonly container: Pick<Container, 'resolve'>,
    private readonly config: Record<string, unknown> = {},
    namespaces: ReadonlyArray<AnyConfigNamespace> = [],
    private readonly validateSchema?: ConfigSchema,
  ) {
    for (const ns of namespaces) {
      this.namespaceKeys.set(ns.namespace, ns.KEY as unknown as Token);
    }
  }

  /** Read a value by dot-notation path; `undefined` if absent. */
  get(path: string): unknown {
    this.ensureValidated();
    return this.read(path);
  }

  /** Read a value by dot-notation path; throws if absent. */
  getOrThrow(path: string): unknown {
    const value = this.get(path);
    if (value === undefined) {
      throw new Error(`Configuration key "${path}" was not found`);
    }
    return value;
  }

  /** Whether a dot-notation path resolves to a defined value. */
  has(path: string): boolean {
    this.ensureValidated();
    return this.read(path) !== undefined;
  }

  /** The full merged config object (flat record + resolved namespaces). */
  all(): Record<string, unknown> {
    this.ensureValidated();
    return this.merged();
  }

  private read(path: string): unknown {
    const [head, ...rest] = path.split('.');
    if (head === undefined || DANGEROUS_KEYS.has(head)) return undefined;

    let current: unknown = this.namespaceKeys.has(head)
      ? this.resolveNamespace(head)
      : this.config[head];

    for (const key of rest) {
      if (DANGEROUS_KEYS.has(key)) return undefined;
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  /** Resolve a namespace's KEY through the container on first use, then cache. */
  private resolveNamespace(namespace: string): unknown {
    if (this.cache.has(namespace)) return this.cache.get(namespace);
    const key = this.namespaceKeys.get(namespace);
    const value = key === undefined ? undefined : this.container.resolve(key);
    this.cache.set(namespace, value);
    return value;
  }

  private merged(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.config };
    for (const namespace of this.namespaceKeys.keys()) {
      out[namespace] = this.resolveNamespace(namespace);
    }
    return out;
  }

  /**
   * Validate the merged config once, on first read. Deferred (not at bootstrap)
   * because the merged shape needs namespace factories — and their env — which
   * are only available after bootstrap on edge runtimes.
   */
  private ensureValidated(): void {
    if (this.validated) {
      if (this.validationError) throw this.validationError; // fail-closed on every read
      return;
    }
    this.validated = true; // run the schema exactly once
    if (!this.validateSchema) return;
    try {
      runSchema(this.validateSchema, this.merged());
    } catch (err) {
      this.validationError = err;
      throw err;
    }
  }
}

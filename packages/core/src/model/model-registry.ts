/**
 * Eager model-registry factory (ported near-verbatim from hono-crud 0.13
 * `core/model-registry.ts`; `RelationConfig.model` is renamed `target` and
 * each wired entry is normalized through {@link defineModel}).
 *
 * `defineModels({...})` lets every cross-referencing model be authored in ONE
 * call, referencing siblings by registry key — so a circular graph
 * (User.relations.posts ↔ Post.relations.author) is inert data: no declaration
 * ordering, no thunks, no hand-duplicated schema/table consts. Eagerly, at the
 * call site, the factory:
 *
 *  1. validates each internal relation target against the sibling keys
 *     (aggregating every miss into one setup-time `Error` with a did-you-mean),
 *  2. auto-populates each relation's `schema` (the sibling's BASE schema) and
 *     `table` (the sibling's `Model.table` reference the drizzle adapter needs),
 *  3. rewrites `relation.target` from the registry key to the sibling's
 *     `tableName`, the form the adapters resolve by,
 *  4. normalizes each entry via {@link defineModel} (resolved defaults).
 *
 * Wired models are FRESH objects — author inputs are never mutated — and the
 * output is deterministic per call with no module-global state (edge-safe).
 * Off-registry targets (cross-package, polymorphic) opt out per relation via
 * `external: true` and author a raw {@link RelationConfig}.
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { defineModel } from './define-model';
import type { Model, ModelConfig, RelationConfig, RelationsConfig, SchemaKeys } from './model.types';

/** Registry key → its Zod schema; the value-map the field constraints read. */
type RelationSchemaMap = Record<string, ZodObject<ZodRawShape>>;

/** Schema keys of one member, degrading to `string` for a wide schema. */
type FieldKeys<TSchemas extends RelationSchemaMap, K extends keyof TSchemas> = Extract<
  SchemaKeys<TSchemas[K]>,
  string
>;

/**
 * Passthrough members shared by both internal arms (`cascade` stays
 * `string`-typed — it carries no cross-model column names), plus the
 * schema/table overrides and the escape-hatch discriminant.
 */
type InternalRelationBase = Omit<
  RelationConfig,
  'type' | 'target' | 'foreignKey' | 'localKey' | 'schema' | 'table' | 'external'
> & {
  /** Optional explicit schema override (else auto-populated from the sibling). */
  schema?: ZodObject<ZodRawShape>;
  /** Optional explicit table override (else auto-populated from the sibling). */
  table?: unknown;
  external?: false;
};

/**
 * hasOne / hasMany: the FK lives on the RELATED table, so `foreignKey` is
 * checked against the target sibling's (`M`) schema keys and `localKey`
 * against the authoring model's (`TSelf`).
 */
type InternalHasSpec<TSchemas extends RelationSchemaMap, TSelf extends keyof TSchemas> = {
  [M in Extract<keyof TSchemas, string>]: InternalRelationBase & {
    type: 'hasOne' | 'hasMany';
    target: M;
    foreignKey: FieldKeys<TSchemas, M>;
    localKey?: FieldKeys<TSchemas, TSelf>;
  };
}[Extract<keyof TSchemas, string>];

/**
 * belongsTo: the local row holds the FK, so the direction flips — `foreignKey`
 * is checked against the authoring model's (`TSelf`) schema keys and
 * `localKey` against the target sibling's (`M`).
 */
type InternalBelongsToSpec<TSchemas extends RelationSchemaMap, TSelf extends keyof TSchemas> = {
  [M in Extract<keyof TSchemas, string>]: InternalRelationBase & {
    type: 'belongsTo';
    target: M;
    foreignKey: FieldKeys<TSchemas, TSelf>;
    localKey?: FieldKeys<TSchemas, M>;
  };
}[Extract<keyof TSchemas, string>];

/** Off-registry escape hatch: raw {@link RelationConfig}, no key checking. */
type ExternalRelationSpec = RelationConfig & {
  /** Opt out of sibling-key + field-key checking and auto-population. */
  external: true;
};

/**
 * A relation authored inside a `defineModels({...})` entry.
 *
 * **Internal form (default):** `target` is constrained to the sibling registry
 * keys, and the column-name members to the direction-correct schema keys —
 * hasOne/hasMany take `foreignKey` from the RELATED sibling and `localKey` from
 * the authoring model; belongsTo flips both. A typo is a compile error. Wide
 * (un-narrowed) schemas degrade every check to permissive `string`.
 * `schema`/`table` are auto-populated from the sibling, so you normally omit
 * them; explicitly-authored ones win (see {@link DefineModelsConfig.overwriteExplicit}).
 *
 * **External form (escape hatch):** set `external: true` to target a model that
 * is NOT a sibling — cross-file, cross-package, or polymorphic. All constraints
 * and auto-population are switched off; the marker is stripped from the output.
 */
export type RelationSpec<TSchemas extends RelationSchemaMap, TSelf extends keyof TSchemas> =
  | InternalHasSpec<TSchemas, TSelf>
  | InternalBelongsToSpec<TSchemas, TSelf>
  | ExternalRelationSpec;

/**
 * One registry entry as authored: the existing {@link ModelConfig}, except
 * relation values reference siblings by key ({@link RelationSpec}).
 */
export type ModelSpec<
  TSchemas extends RelationSchemaMap,
  TSelf extends keyof TSchemas,
  T extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TTable = unknown,
> = Omit<ModelConfig<T, TTable, RelationsConfig>, 'relations'> & {
  relations?: Record<string, RelationSpec<TSchemas, TSelf>>;
};

/**
 * Setup bag for {@link defineModels}. The defaults close the silent gaps that
 * hand-authored relation configs accumulate (missing `schema` → the relation
 * is omitted from include/nested-write shapes; missing `table` → the drizzle
 * include silently no-ops).
 */
export interface DefineModelsConfig {
  /**
   * Back-fill `relation.schema` from the target sibling's BASE `schema`.
   * @default true
   */
  autoPopulateSchema?: boolean;
  /**
   * Back-fill `relation.table` from the target sibling's `table` reference.
   * @default true
   */
  autoPopulateTable?: boolean;
  /**
   * Overwrite explicitly-authored `schema`/`table` with the sibling's values.
   * @default false — the author's explicit value wins.
   */
  overwriteExplicit?: boolean;
  /**
   * Unknown internal relation target: `'throw'` aggregates every miss into ONE
   * setup-time `Error` (with a did-you-mean); `'ignore'` leaves it unresolved.
   * @default 'throw'
   */
  onUnknownModel?: 'throw' | 'ignore';
  /**
   * Freeze the returned models, their `relations` containers, and each wired
   * relation config (schemas/tables left unfrozen).
   * @default false
   */
  freeze?: boolean;
}

/**
 * Normalize an entry's relation values to bare {@link RelationConfig} while
 * preserving the literal relation-name keys.
 */
type WiredRelations<E> = E extends { relations?: infer R }
  ? [R] extends [object]
    ? { [K in keyof R & string]: RelationConfig }
    : RelationsConfig
  : RelationsConfig;

/** The wired, NORMALIZED {@link Model} produced for one entry. */
export type WiredModel<E> = E extends {
  schema: infer T extends ZodObject<ZodRawShape>;
  table?: infer TTable;
}
  ? Model<T, TTable, WiredRelations<E>>
  : E extends { schema: infer T extends ZodObject<ZodRawShape> }
    ? Model<T, unknown, WiredRelations<E>>
    : never;

/** The wired output map: each key preserves its narrow {@link WiredModel}. */
export type WiredModels<TMap> = { [K in keyof TMap]: WiredModel<TMap[K]> };

/** Re-extract an entry's own concrete Zod schema for its schema-key checks. */
type SchemaOf<E> = E extends { schema: infer S extends ZodObject<ZodRawShape> }
  ? S
  : ZodObject<ZodRawShape>;

/** Re-extract an entry's own concrete table type for its override typing. */
type TableOf<E> = E extends { table?: infer TTable } ? TTable : unknown;

/** The value-self-referential schema map read by every entry's field constraints. */
type SchemasOf<TMap> = { [K in keyof TMap]: SchemaOf<TMap[K]> };

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

/** Minimal structural shape both author configs and wired Models satisfy. */
interface WiringEntry {
  tableName: string;
  schema?: ZodObject<ZodRawShape>;
  table?: unknown;
  relations?: RelationsConfig;
}

/** One unresolved internal relation target, for the aggregated setup error. */
interface UnknownTarget {
  modelKey: string;
  relationName: string;
  target: string;
}

/** An authored relation value before the `external` marker is stripped. */
type AuthoredRelation = RelationConfig & { external?: boolean };

/** Classic two-row Levenshtein distance (sync, allocation-light). */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** Closest registry key to `target`, when close enough to be a likely typo. */
function suggestRegistryKey(target: string, knownKeys: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of knownKeys) {
    const distance = levenshteinDistance(target.toLowerCase(), key.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(target.length / 2)) ? best : undefined;
}

/** Aggregated, suggestion-bearing message for every unknown internal target. */
function formatUnknownTargets(misses: readonly UnknownTarget[], knownKeys: readonly string[]): string {
  const details = misses
    .map(({ modelKey, relationName, target }) => {
      const suggestion = suggestRegistryKey(target, knownKeys);
      const hint = suggestion ? ` (did you mean '${suggestion}'?)` : '';
      return `${modelKey}.relations.${relationName} → '${target}'${hint}`;
    })
    .join('; ');
  return `defineModels: unknown relation target(s): ${details}. Known registry keys: ${knownKeys.join(', ')}. Add the target model to this defineModels call, or mark the relation \`external: true\` and author its schema/table explicitly.`;
}

/** {@link DefineModelsConfig} with every default applied. */
interface ResolvedDefineModelsConfig {
  autoPopulateSchema: boolean;
  autoPopulateTable: boolean;
  overwriteExplicit: boolean;
  onUnknownModel: 'throw' | 'ignore';
  freeze: boolean;
}

/** Apply the {@link DefineModelsConfig} defaults. */
function resolveDefineModelsConfig(config: DefineModelsConfig): ResolvedDefineModelsConfig {
  return {
    autoPopulateSchema: config.autoPopulateSchema ?? true,
    autoPopulateTable: config.autoPopulateTable ?? true,
    overwriteExplicit: config.overwriteExplicit ?? false,
    onUnknownModel: config.onUnknownModel ?? 'throw',
    freeze: config.freeze ?? false,
  };
}

/**
 * Validation sweep: every internal relation target that is neither a same-call
 * sibling key nor a base-map key. Runs to completion BEFORE any wiring so a
 * bad map never yields a half-wired graph and every miss surfaces in one error.
 */
function collectUnknownTargets(
  copies: Record<string, ModelConfig>,
  base: Record<string, WiringEntry>,
): UnknownTarget[] {
  const misses: UnknownTarget[] = [];
  for (const [modelKey, model] of Object.entries(copies)) {
    for (const [relationName, authored] of Object.entries(model.relations ?? {})) {
      const spec = authored as AuthoredRelation;
      if (spec.external === true) continue;
      const target = spec.target;
      if (target == null) continue;
      if (!Object.hasOwn(copies, target) && !Object.hasOwn(base, target)) {
        misses.push({ modelKey, relationName, target });
      }
    }
  }
  return misses;
}

/**
 * Own-property sibling lookup (same-call siblings shadow base-map keys).
 * `Object.hasOwn` guards both maps so an unresolved target colliding with an
 * `Object.prototype` member (e.g. `'constructor'` under `onUnknownModel:
 * 'ignore'`) is never wired against the prototype.
 */
function lookupSibling(
  key: string,
  copies: Record<string, WiringEntry>,
  base: Record<string, WiringEntry>,
): WiringEntry | undefined {
  if (Object.hasOwn(copies, key)) return copies[key];
  if (Object.hasOwn(base, key)) return base[key];
  return undefined;
}

/**
 * Wire one relation: fresh object (author input never mutated), sibling
 * auto-population, and the registry-key → tableName rewrite. Same-call siblings
 * shadow base-map keys. External relations pass through untouched apart from
 * the stripped marker.
 */
function wireRelation(
  authored: AuthoredRelation,
  copies: Record<string, WiringEntry>,
  base: Record<string, WiringEntry>,
  config: ResolvedDefineModelsConfig,
): RelationConfig {
  const { external, ...relation } = authored;
  const key = relation.target;
  const sibling = external === true || key == null ? undefined : lookupSibling(key, copies, base);
  if (!sibling) return relation;
  if (config.autoPopulateSchema && (config.overwriteExplicit || relation.schema == null)) {
    relation.schema = sibling.schema;
  }
  const tableUnset = config.overwriteExplicit || relation.table == null;
  if (config.autoPopulateTable && tableUnset && sibling.table != null) {
    relation.table = sibling.table;
  }
  relation.target = sibling.tableName;
  return relation;
}

/** Freeze wired models, their relations containers, and each relation config. */
function freezeWiredModels(wired: Record<string, Model>): void {
  for (const model of Object.values(wired)) {
    if (model.relations) {
      for (const relation of Object.values(model.relations)) Object.freeze(relation);
      Object.freeze(model.relations);
    }
    Object.freeze(model);
  }
}

/**
 * The shared wiring core: copy, validate everything, wire relations, normalize.
 * Only the NEW map's models are wired (and, with `freeze`, frozen) — base
 * models were already wired by their own producing call.
 */
function wireModelMap(
  map: object,
  base: Record<string, Model>,
  resolved: ResolvedDefineModelsConfig,
): Record<string, Model> {
  // Pass 1 — shallow-copy every entry so author inputs are never mutated.
  const copies: Record<string, ModelConfig> = {};
  for (const [key, spec] of Object.entries(map)) {
    copies[key] = { ...(spec as ModelConfig) };
  }

  // Pass 2a — validate EVERY internal relation target before wiring anything.
  const misses = collectUnknownTargets(copies, base);
  if (misses.length > 0 && resolved.onUnknownModel === 'throw') {
    throw new Error(formatUnknownTargets(misses, [...Object.keys(base), ...Object.keys(copies)]));
  }

  // Pass 2b — wire relations (fresh objects, auto-population, key→tableName
  // rewrite) then normalize each entry through defineModel.
  const wired: Record<string, Model> = {};
  for (const [key, copy] of Object.entries(copies)) {
    let relations = copy.relations;
    if (relations) {
      const rewired: Record<string, RelationConfig> = {};
      for (const [relationName, authored] of Object.entries(relations)) {
        rewired[relationName] = wireRelation(authored as AuthoredRelation, copies, base, resolved);
      }
      relations = rewired;
    }
    wired[key] = defineModel({ ...copy, relations } as ModelConfig) as Model;
  }

  if (resolved.freeze) freezeWiredModels(wired);

  return wired;
}

/**
 * Author every cross-referencing model in ONE call. Sibling references are
 * registry keys, so circular graphs need no ordering games, and each
 * relation's `schema`/`table` is auto-populated from its target. Returns
 * fully-wired, NORMALIZED {@link Model} objects.
 *
 * Setup-time validation failures throw a plain `Error` aggregating every
 * unknown target at once.
 *
 * @example
 * ```ts
 * const db = defineModels({
 *   users: {
 *     name: 'user', tableName: 'users', schema: UserSchema, primaryKeys: ['id'],
 *     relations: { posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
 *   },
 *   posts: {
 *     name: 'post', tableName: 'posts', schema: PostSchema, primaryKeys: ['id'],
 *     relations: { author: { type: 'belongsTo', target: 'users', foreignKey: 'authorId' } },
 *   },
 * });
 * // db.users.relations.posts.schema === PostSchema (auto-populated)
 * ```
 */
export function defineModels<
  TMap extends {
    [K in keyof TMap]: ModelSpec<SchemasOf<TMap>, K, SchemaOf<TMap[K]>, TableOf<TMap[K]>>;
  },
>(map: TMap, config: DefineModelsConfig = {}): WiredModels<TMap> {
  return wireModelMap(map, {}, resolveDefineModelsConfig(config)) as WiredModels<TMap>;
}

/**
 * Setup bag for {@link defineModelsExtending} — the {@link DefineModelsConfig}
 * knobs plus the base map whose keys become referenceable siblings.
 */
export interface DefineModelsExtendConfig<TBase extends Record<string, Model>>
  extends DefineModelsConfig {
  /** A previously-wired map whose keys become referenceable siblings. */
  extends: TBase;
}

/**
 * Incremental adoption: wire a new map whose relations may also target the keys
 * of an ALREADY-WIRED base map — composing registries acyclically across
 * files/calls (a true cycle must be co-located in one {@link defineModels}
 * call). Same-call siblings shadow base keys; the returned map exposes base
 * entries alongside the new ones, and the base models are never re-wired,
 * mutated, or frozen by this call.
 */
export function defineModelsExtending<
  TBase extends Record<string, Model>,
  TMap extends {
    [K in keyof TMap]: ModelSpec<
      SchemasOf<TMap> & { [B in keyof TBase]: TBase[B]['schema'] },
      K,
      SchemaOf<TMap[K]>,
      TableOf<TMap[K]>
    >;
  },
>(map: TMap, config: DefineModelsExtendConfig<TBase>): WiredModels<TMap> & TBase {
  const { extends: base, ...knobs } = config;
  const wired = wireModelMap(map, base, resolveDefineModelsConfig(knobs));
  return { ...base, ...wired } as WiredModels<TMap> & TBase;
}

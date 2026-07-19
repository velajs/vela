/**
 * Capability negotiation shapes. Studio's `studio.capabilities` op returns this
 * derived, wire-facing view: which feature namespaces are live, which write
 * gates are open, and the time-travel capability shape (or `null` when unbound).
 *
 * The server config expresses editable permission in 4 categories
 * (data / schema / identity / ops); the wire carries only the derived
 * {@link StudioWriteGates} below.
 */
import type { TimeTravelCapabilities } from './time-travel';

/**
 * The closed set of feature keys the UI navigates by. `const` array + derived
 * union so a feature panel can light up iff the app actually wired that package.
 */
export const STUDIO_FEATURE_KEYS = [
  'app',
  'openapi',
  'data',
  'timeTravel',
  'transfer',
  'auth',
  'authOrganizations',
  'queue',
  'schedule',
  'flags',
  'logs',
  'audit',
  'live',
  'presence',
] as const;

/** Union of every Studio feature key. */
export type StudioFeatureKey = (typeof STUDIO_FEATURE_KEYS)[number];

/**
 * The derived, wire-facing write gates. Default all `false` -> read-only Studio.
 * Op dispatch gates a write op against the gate named in its meta.
 */
export interface StudioWriteGates {
  /** Data-row create/update/delete/generate is permitted. */
  dataEditable: boolean;
  /** Schema-level edits are permitted. */
  schemaEditable: boolean;
  /** Operational actions (queue send/replay, schedule run-now, session revoke). */
  opsEditable: boolean;
  /** Reads/writes may run as a supplied identity. */
  runAsIdentity: boolean;
  /** Time-travel restore/undo/prune is permitted. */
  timeTravelRestore: boolean;
  /** Transfer import (bulk NDJSON ingest) is permitted. */
  transferImport: boolean;
}

/**
 * The full capability descriptor returned by `studio.capabilities`.
 * `timeTravel` is `null` when no {@link TimeTravelPort} is bound.
 */
export interface StudioCapabilities {
  features: Record<StudioFeatureKey, boolean>;
  writes: StudioWriteGates;
  timeTravel: TimeTravelCapabilities | null;
}

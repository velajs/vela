/**
 * Extended-verb executor registry. Each family module owns ONE file and
 * exports a partial map of executors; the registry composes them and derives
 * the implemented-verb set — `verb-table.ts` stays static and `stamp-routes`
 * / `resource.execute` never need editing when a family lands.
 */

import type { CrudEndpointName } from '../../verb-table';
import type { EngineRequest, EngineResult } from '../engine-request';
import type { AnyResource } from '../verb-helpers';
import { restoreCloneUpsertExecutors } from './restore-clone-upsert';
import { batchExecutors } from './batch';
import { queryVerbExecutors } from './query-verbs';
import { versioningExecutors } from './versioning';

export type VerbExecutor = (resource: AnyResource, req: EngineRequest) => Promise<EngineResult>;

const CORE_ENDPOINTS: readonly CrudEndpointName[] = ['create', 'list', 'read', 'update', 'delete'];

export const EXTENDED_EXECUTORS: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  ...restoreCloneUpsertExecutors,
  ...batchExecutors,
  ...queryVerbExecutors,
  ...versioningExecutors,
};

/** Every verb the engine can execute today (core five + registered extended). */
export function implementedEndpoints(): CrudEndpointName[] {
  return [...CORE_ENDPOINTS, ...(Object.keys(EXTENDED_EXECUTORS) as CrudEndpointName[])];
}

/**
 * Batch family: batchCreate/Update/Delete/Restore/Upsert + bulkPatch.
 * Executors register here and surface through `./registry`.
 */

import type { CrudEndpointName } from '../../verb-table';
import type { VerbExecutor } from './registry';

export const batchExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  // M4: batchCreate, batchUpdate, batchDelete, batchRestore, batchUpsert,
  // bulkPatch land here.
};

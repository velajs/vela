/**
 * Point-verb family: restore, clone, upsert. Executors register here and
 * surface through `./registry` — see that file for the composition contract.
 */

import type { CrudEndpointName } from '../../verb-table';
import type { VerbExecutor } from './registry';

export const restoreCloneUpsertExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  // M4: restore, clone, upsert land here.
};

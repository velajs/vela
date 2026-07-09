/**
 * Query-verb family: search, aggregate, export, import. Executors register
 * here and surface through `./registry`.
 */

import type { CrudEndpointName } from '../../verb-table';
import type { VerbExecutor } from './registry';

export const queryVerbExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  // M4: search, aggregate, export, import land here.
};

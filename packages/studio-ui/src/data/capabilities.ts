/**
 * `useStudioCapabilities` with DEFAULTS-SHOWN semantics: while the
 * `studio.capabilities` op is loading or undefined, every feature reads `true`
 * (nothing flickers hidden), every write gate reads `false` (no write affordance
 * appears optimistically), and `timeTravel` is `null`.
 */
import type { StudioCapabilities, StudioWriteGates } from '@velajs/studio-protocol';
import type { AdminError } from '../client/admin-client';
import { useAdminQuery } from './query';

/**
 * The full feature map defaulted to shown. Written as an explicit literal (not a
 * derived map) so it doubles as a drift guard: adding a feature key to the
 * protocol breaks this until it is defaulted here on purpose.
 */
const FEATURES_SHOWN: StudioCapabilities['features'] = {
  app: true,
  openapi: true,
  data: true,
  timeTravel: true,
  transfer: true,
  auth: true,
  authOrganizations: true,
  queue: true,
  schedule: true,
  flags: true,
  logs: true,
  audit: true,
  live: true,
  presence: true,
};

const WRITES_CLOSED: StudioWriteGates = {
  dataEditable: false,
  schemaEditable: false,
  opsEditable: false,
  runAsIdentity: false,
  timeTravelRestore: false,
  transferImport: false,
};

/** The defaults-shown capability snapshot used until the server answers. */
export const DEFAULT_CAPABILITIES: StudioCapabilities = {
  features: FEATURES_SHOWN,
  operations: [],
  writes: WRITES_CLOSED,
  timeTravel: null,
};

export interface StudioCapabilitiesResult {
  capabilities: StudioCapabilities;
  isLoading: boolean;
  error: AdminError | null;
}

export function useStudioCapabilities(): StudioCapabilitiesResult {
  const query = useAdminQuery('studio.capabilities', {});
  return {
    capabilities: query.data ?? DEFAULT_CAPABILITIES,
    isLoading: query.isLoading,
    error: query.error,
  };
}

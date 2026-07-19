/**
 * The React data layer: the client/transport provider, the `useAdminQuery`
 * family over React Query, and capability negotiation with defaults-shown
 * semantics.
 */
export { AdminClientProvider, useAdminClient, useAdminTransport } from './context';
export type { AdminClientProviderProps } from './context';
export { adminQueryKey, useAdminMutation, useAdminQuery, useInvalidateAdmin } from './query';
export type {
  AdminQueryKey,
  AdminQueryResult,
  UseAdminMutationOptions,
  UseAdminQueryOptions,
} from './query';
export { DEFAULT_CAPABILITIES, useStudioCapabilities } from './capabilities';
export type { StudioCapabilitiesResult } from './capabilities';

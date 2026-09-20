/**
 * The React data layer over `@tanstack/react-query`. Every hook dispatches
 * through the context {@link TransportLike} and normalizes failures to
 * {@link AdminError}, so callers get `{ data, error: AdminError | null, ... }`.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { StudioOp, StudioRpcMap } from '@velajs/studio-protocol';
import { toAdminError } from '../client/admin-client';
import type { AdminError } from '../client/admin-client';
import { useAdminTransport } from './context';

/** The stable query key for an op + args: `['vela-admin', op, args]`. */
export type AdminQueryKey<Op extends StudioOp> = readonly [
  'vela-admin',
  Op,
  StudioRpcMap[Op]['req'],
];

export function adminQueryKey<Op extends StudioOp>(
  op: Op,
  args: StudioRpcMap[Op]['req'],
): AdminQueryKey<Op> {
  return ['vela-admin', op, args] as const;
}

export interface UseAdminQueryOptions {
  /** Gate the query; `false` keeps it idle. */
  enabled?: boolean;
  /** Poll interval in ms (v1 streaming panels poll — there is no WS leg). */
  refetchInterval?: number | false;
  /** Keep the prior page's data visible while refetching. */
  keepPreviousData?: boolean;
  /** How long results stay fresh before a background refetch. */
  staleTime?: number;
}

export interface AdminQueryResult<Op extends StudioOp> {
  data: StudioRpcMap[Op]['res'] | undefined;
  error: AdminError | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useAdminQuery<Op extends StudioOp>(
  op: Op,
  args: StudioRpcMap[Op]['req'],
  options: UseAdminQueryOptions = {},
): AdminQueryResult<Op> {
  const transport = useAdminTransport();
  const query = useQuery<
    StudioRpcMap[Op]['res'],
    AdminError,
    StudioRpcMap[Op]['res'],
    AdminQueryKey<Op>
  >({
    queryKey: adminQueryKey(op, args),
    queryFn: async ({ signal }) => {
      try {
        return await transport.rpc(op, args, { signal });
      } catch (err) {
        throw toAdminError(err);
      }
    },
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
    staleTime: options.staleTime,
    placeholderData: options.keepPreviousData ? keepPreviousData : undefined,
  });
  return {
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface UseAdminMutationOptions {
  /** Ops whose cached queries are invalidated after a successful write. */
  invalidates?: StudioOp[];
}

export function useAdminMutation<Op extends StudioOp>(
  op: Op,
  options: UseAdminMutationOptions = {},
): UseMutationResult<StudioRpcMap[Op]['res'], AdminError, StudioRpcMap[Op]['req']> {
  const transport = useAdminTransport();
  const queryClient = useQueryClient();
  return useMutation<StudioRpcMap[Op]['res'], AdminError, StudioRpcMap[Op]['req']>({
    mutationFn: async (args) => {
      try {
        return await transport.rpc(op, args);
      } catch (err) {
        throw toAdminError(err);
      }
    },
    onSuccess: async () => {
      const invalidates = options.invalidates;
      if (invalidates === undefined) return;
      await Promise.all(
        invalidates.map((invOp) =>
          queryClient.invalidateQueries({ queryKey: ['vela-admin', invOp] }),
        ),
      );
    },
  });
}

/** Imperatively invalidate admin queries: all, one op, or one op+args. */
export function useInvalidateAdmin(): <Op extends StudioOp>(
  op?: Op,
  args?: StudioRpcMap[Op]['req'],
) => Promise<void> {
  const queryClient = useQueryClient();
  return (op, args) => {
    const queryKey =
      op === undefined
        ? ['vela-admin']
        : args === undefined
          ? ['vela-admin', op]
          : ['vela-admin', op, args];
    return queryClient.invalidateQueries({ queryKey });
  };
}

/**
 * The admin data context. Carries the {@link TransportLike} seam (so
 * `FakeAdminTransport` slots in for tests) plus an optional concrete
 * {@link AdminClient}, and mounts a React Query client so the hooks always have
 * one — a single `<AdminClientProvider>` is all a test or embed needs.
 */
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminClient, TransportLike } from '../client/admin-client';

interface AdminContextValue {
  transport: TransportLike;
  client?: AdminClient;
}

const AdminContext = createContext<AdminContextValue | null>(null);

function makeDefaultQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}

export interface AdminClientProviderProps {
  /** The transport hooks dispatch through (an `AdminClient` or a fake). */
  transport: TransportLike;
  /** The concrete client, when available (exposes `health`/`setToken`). */
  client?: AdminClient;
  /** Supply a shared React Query client; one is created per provider otherwise. */
  queryClient?: QueryClient;
  children: ReactNode;
}

export function AdminClientProvider({
  transport,
  client,
  queryClient,
  children,
}: AdminClientProviderProps): ReactNode {
  const resolvedQueryClient = useMemo(() => queryClient ?? makeDefaultQueryClient(), [queryClient]);
  const value = useMemo<AdminContextValue>(() => ({ transport, client }), [transport, client]);
  return (
    <AdminContext.Provider value={value}>
      <QueryClientProvider client={resolvedQueryClient}>{children}</QueryClientProvider>
    </AdminContext.Provider>
  );
}

/** The transport from context; throws if no provider is mounted. */
export function useAdminTransport(): TransportLike {
  const ctx = useContext(AdminContext);
  if (ctx === null) {
    throw new Error('useAdminTransport must be used within an <AdminClientProvider>.');
  }
  return ctx.transport;
}

/** The concrete client from context, if one was provided. */
export function useAdminClient(): AdminClient | undefined {
  return useContext(AdminContext)?.client;
}

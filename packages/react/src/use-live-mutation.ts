import { useCallback, useRef, useState } from 'react';
import type { MutateOptions } from '@velajs/client';
import { useLiveClient } from './context';

export interface UseLiveMutationResult<R> {
  /** Fire the mutation. Per-call options (optimistic targets, method, …) merge over the hook defaults. */
  mutate: (body?: unknown, options?: MutateOptions) => Promise<R>;
  pending: boolean;
  data: R | undefined;
  error: unknown;
  reset: () => void;
}

/**
 * HTTP mutation hook with live-aware optimistic updates:
 *
 * ```tsx
 * const { mutate: addTodo, pending } = useLiveMutation('/todos', {
 *   optimistic: { query: 'todos.list', args: { listId }, apply: (t = []) => [...t, temp] },
 * });
 * ```
 *
 * The optimistic layer is dropped exactly when a live frame's cursor passes
 * the mutation's `Vela-Commit-Cursor` (see @velajs/client); failures roll it
 * back and reject.
 */
export function useLiveMutation<R = unknown>(
  path: string,
  defaults?: MutateOptions,
): UseLiveMutationResult<R> {
  const client = useLiveClient();
  const [state, setState] = useState<{ pending: number; data?: R; error?: unknown }>({ pending: 0 });
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const mutate = useCallback(
    async (body?: unknown, options?: MutateOptions): Promise<R> => {
      setState((current) => ({ ...current, pending: current.pending + 1 }));
      try {
        const data = await client.mutate<R>(path, body, { ...defaultsRef.current, ...options });
        setState((current) => ({ pending: current.pending - 1, data, error: undefined }));
        return data;
      } catch (error) {
        setState((current) => ({ ...current, pending: current.pending - 1, error }));
        throw error;
      }
    },
    [client, path],
  );

  return {
    mutate,
    pending: state.pending > 0,
    data: state.data,
    error: state.error,
    reset: useCallback(() => setState({ pending: 0 }), []),
  };
}

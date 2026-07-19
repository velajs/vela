/**
 * `useConfirmedMutation` — the 428 confirm-challenge-aware mutation wrapper.
 *
 * A destructive Studio op (e.g. `data.deleteRows`, `data.clearTable`) called
 * without a valid token answers with a 428 `STUDIO_CONFIRM_REQUIRED` carrying a
 * single-use `details.{confirmToken,summary}`. This hook drives the state
 * machine: fire the op; on a 428, surface `details.summary` through
 * `pendingConfirm`; on `confirm()`, re-fire the IDENTICAL args plus the token;
 * on `cancel()`, abort. Any non-428 failure passes through verbatim as an
 * {@link AdminError}. M7b's delete/clear/generate flows and M8b's time-travel
 * restore/prune all wrap their destructive op in this one hook.
 */
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StudioOp, StudioOpReq, StudioOpRes } from '@velajs/studio-protocol';
import { toAdminError } from '../client/admin-client';
import type { AdminError } from '../client/admin-client';
import { useAdminTransport } from './context';

/** The confirm challenge decoded from a 428 `STUDIO_CONFIRM_REQUIRED` error. */
export interface ConfirmChallenge {
  confirmToken: string;
  summary: string;
  expiresAt?: string;
}

/**
 * Decode the confirm challenge from an {@link AdminError}, or `null` when the
 * error is not a well-formed 428 `STUDIO_CONFIRM_REQUIRED`. Kept pure and
 * exported so the state machine (and its tests) can assert on it directly.
 */
export function readConfirmChallenge(error: AdminError): ConfirmChallenge | null {
  if (error.status !== 428 || error.code !== 'STUDIO_CONFIRM_REQUIRED') return null;
  const details = error.body.details;
  if (typeof details !== 'object' || details === null) return null;
  const record: Record<string, unknown> = details as Record<string, unknown>;
  const token = record.confirmToken;
  const summary = record.summary;
  if (typeof token !== 'string' || typeof summary !== 'string') return null;
  const challenge: ConfirmChallenge = { confirmToken: token, summary };
  if (typeof record.expiresAt === 'string') challenge.expiresAt = record.expiresAt;
  return challenge;
}

/** The pending confirmation surfaced to a confirm dialog. */
export interface PendingConfirm {
  summary: string;
}

export interface UseConfirmedMutationOptions<Op extends StudioOp> {
  /** Ops whose cached queries are invalidated after a successful write. */
  invalidates?: StudioOp[];
  /** Called with the result after a confirmed (or unchallenged) success. */
  onSuccess?: (data: StudioOpRes<Op>) => void;
}

export interface UseConfirmedMutationResult<Op extends StudioOp> {
  /** Fire the op with `args`. On a 428, `pendingConfirm` fills instead of `data`. */
  mutate: (args: StudioOpReq<Op>) => void;
  /** True while a `mutate`/`confirm` request is in flight. */
  isPending: boolean;
  /** The awaiting-confirmation challenge, or `null`. */
  pendingConfirm: PendingConfirm | null;
  /** Re-fire the stashed args plus the challenge token. */
  confirm: () => void;
  /** Abort the pending confirmation without re-firing. */
  cancel: () => void;
  /** Clear all state back to idle. */
  reset: () => void;
  /** The last non-428 failure, or `null`. */
  error: AdminError | null;
  /** The last successful result, or `undefined`. */
  data: StudioOpRes<Op> | undefined;
}

interface StashedChallenge<Op extends StudioOp> {
  args: StudioOpReq<Op>;
  token: string;
}

export function useConfirmedMutation<Op extends StudioOp>(
  op: Op,
  options: UseConfirmedMutationOptions<Op> = {},
): UseConfirmedMutationResult<Op> {
  const transport = useAdminTransport();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [error, setError] = useState<AdminError | null>(null);
  const [data, setData] = useState<StudioOpRes<Op> | undefined>(undefined);

  // A ref (not state) holds the stashed args+token so `confirm` never reads a
  // stale closure, and so a double-click can't re-fire a spent challenge.
  const stashRef = useRef<StashedChallenge<Op> | null>(null);
  // Latest options without re-creating `run` on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const run = useCallback(
    async (args: StudioOpReq<Op>): Promise<void> => {
      setIsPending(true);
      setError(null);
      try {
        const result = await transport.rpc(op, args);
        stashRef.current = null;
        setPendingConfirm(null);
        setData(result);
        const invalidates = optionsRef.current.invalidates;
        if (invalidates !== undefined) {
          await Promise.all(
            invalidates.map((invOp) =>
              queryClient.invalidateQueries({ queryKey: ['vela-admin', invOp] }),
            ),
          );
        }
        optionsRef.current.onSuccess?.(result);
      } catch (err) {
        const adminError = toAdminError(err);
        const challenge = readConfirmChallenge(adminError);
        if (challenge !== null) {
          // A spread of the generic `args` widens to an intersection that stays
          // assignable to `StudioOpReq<Op>`; re-firing overwrites `confirmToken`.
          stashRef.current = { args, token: challenge.confirmToken };
          setPendingConfirm({ summary: challenge.summary });
        } else {
          stashRef.current = null;
          setPendingConfirm(null);
          setError(adminError);
        }
      } finally {
        setIsPending(false);
      }
    },
    [op, transport, queryClient],
  );

  const mutate = useCallback(
    (args: StudioOpReq<Op>): void => {
      setData(undefined);
      void run(args);
    },
    [run],
  );

  const confirm = useCallback((): void => {
    const stashed = stashRef.current;
    if (stashed === null) return;
    stashRef.current = null;
    setPendingConfirm(null);
    void run({ ...stashed.args, confirmToken: stashed.token });
  }, [run]);

  const cancel = useCallback((): void => {
    stashRef.current = null;
    setPendingConfirm(null);
    setIsPending(false);
  }, []);

  const reset = useCallback((): void => {
    stashRef.current = null;
    setPendingConfirm(null);
    setIsPending(false);
    setError(null);
    setData(undefined);
  }, []);

  return { mutate, isPending, pendingConfirm, confirm, cancel, reset, error, data };
}

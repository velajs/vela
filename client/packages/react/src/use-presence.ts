import { useEffect, useRef, useState } from 'react';
import { createPresence } from '@velajs/client/presence';
import type { PresenceMember } from '@velajs/client/presence';
import type { LiveClient, LiveContractShape } from '@velajs/client';

export interface UsePresenceOptions {
  /** Payload attached to this connection's roster entry (latest render's value rides each beat). */
  meta?: unknown;
  /** Keep well under the server TTL (default 10 000 ms vs 30 000 ms). */
  heartbeatIntervalMs?: number;
}

/**
 * Join a room's presence and observe its roster. Heartbeats ride the room's
 * live socket; departure is immediate on close; a tab regaining visibility
 * beats right away so the roster recovers from a throttled background timer.
 *
 * ```tsx
 * const people = usePresence(roomId, { meta: { name: user.name } });
 * ```
 */
export function createUsePresence<C extends LiveContractShape<C>>(
  useLiveClient: () => LiveClient<C>,
) {
  function usePresence(room: string, options?: UsePresenceOptions): PresenceMember[] {
    const client = useLiveClient();
    const [members, setMembers] = useState<PresenceMember[]>([]);
    const metaRef = useRef(options?.meta);
    metaRef.current = options?.meta;
    const heartbeatIntervalMs = options?.heartbeatIntervalMs;

    useEffect(() => {
      const handle = createPresence(client, {
        room,
        meta: () => metaRef.current,
        heartbeatIntervalMs,
        onRoster: setMembers,
      });

      const doc = globalThis.document;
      const onVisibility = (): void => {
        if (doc?.visibilityState === 'visible') handle.beat();
      };
      doc?.addEventListener?.('visibilitychange', onVisibility);

      return () => {
        doc?.removeEventListener?.('visibilitychange', onVisibility);
        handle.stop();
        setMembers([]);
      };
    }, [client, room, heartbeatIntervalMs]);

    return members;
  }

  return usePresence;
}

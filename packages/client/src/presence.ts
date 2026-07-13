import type { LiveClient } from './live-client';
import type { LiveContract, Unsubscribe } from './types';

/**
 * The built-in roster query name served by `@velajs/vela/live`'s presence
 * preset (`PRESENCE_ROSTER_QUERY` on the server side).
 */
export const PRESENCE_ROSTER_QUERY = '$presence.roster';

/** One present connection, as the server's roster query returns it. */
export interface PresenceMember {
  id: string;
  meta?: unknown;
  lastSeen: number;
}

export interface PresenceOptions {
  room: string;
  /** Payload attached to this connection's roster entry (function form re-evaluated per beat). */
  meta?: unknown | (() => unknown);
  /** Keep WELL under the server's TTL (default beat 10 000 ms vs 30 000 ms TTL). */
  heartbeatIntervalMs?: number;
  onRoster?: (members: PresenceMember[]) => void;
}

export interface PresenceHandle {
  /** The last received roster (undefined until the first push). */
  roster(): PresenceMember[] | undefined;
  /** Send an immediate heartbeat (e.g. on visibility regain — the React binding wires this). */
  beat(): void;
  stop(): void;
}

/**
 * Framework-neutral presence: joins a room's roster (heartbeats over the
 * room's live socket) and subscribes to it. Departure is immediate on socket
 * close — the heartbeat/TTL pair only covers ungraceful drops.
 */
export function createPresence(
  client: LiveClient<LiveContract>,
  options: PresenceOptions,
): PresenceHandle {
  const intervalMs = options.heartbeatIntervalMs ?? 10_000;
  let members: PresenceMember[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const beat = (): void => {
    if (stopped) return;
    const meta =
      typeof options.meta === 'function' ? (options.meta as () => unknown)() : options.meta;
    client.presenceBeat(options.room, meta);
  };

  const tick = (): void => {
    timer = undefined;
    if (stopped) return;
    beat();
    timer = setTimeout(tick, intervalMs);
  };

  const unsubscribe: Unsubscribe = client.subscribe(
    PRESENCE_ROSTER_QUERY,
    { room: options.room },
    (value) => {
      members = (value ?? []) as PresenceMember[];
      options.onRoster?.(members);
    },
    { room: options.room },
  );

  // First beat rides after the subscription so the socket is being opened.
  tick();

  return {
    roster: () => members,
    beat,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      unsubscribe();
    },
  };
}

import { InjectionToken } from "@velajs/vela";
import type { LiveSubscriptionRow, PresenceRoomRow } from "@velajs/studio-protocol";

/** App-owned scope: a local engine or explicitly selected Durable Object rooms. */
export interface StudioLiveSource {
  inspect(): Promise<{
    subscriptions: LiveSubscriptionRow[];
    rooms: PresenceRoomRow[];
  }>;
}

export const STUDIO_LIVE_SOURCE = new InjectionToken<StudioLiveSource | undefined>(
  "STUDIO_LIVE_SOURCE",
);

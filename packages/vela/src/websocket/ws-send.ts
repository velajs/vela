import type { WebSocketSendResult } from '@velajs/live-protocol';
import { DEFAULT_WS_MAX_FRAME_BYTES, webSocketFrameFits } from './gateway-routing';
import type { WsClient } from './websocket.types';

/** Supports legacy clients while honoring explicit transport rejection when available. */
export function trySendWebSocketFrame(client: WsClient, payload: string): WebSocketSendResult {
  try {
    if (!webSocketFrameFits(payload, client.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES)) {
      client.close(1009, 'Message too large');
      return 'too-large';
    }
    if (client.trySendRaw) return client.trySendRaw(payload);
    client.sendRaw(payload);
    return 'accepted';
  } catch {
    return 'closed';
  }
}

import type { WebSocketSendResult } from '@velajs/live-protocol';
import { DEFAULT_WS_MAX_FRAME_BYTES, webSocketFrameFits } from './gateway-routing';
import type { WsClient } from './websocket.types';

/** Send through the transport's explicit admission result. */
export function trySendWebSocketFrame(client: WsClient, payload: string): WebSocketSendResult {
  try {
    if (!webSocketFrameFits(payload, client.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES)) {
      client.close(1009, 'Message too large');
      return 'too-large';
    }
    return client.trySendRaw(payload);
  } catch {
    return 'closed';
  }
}

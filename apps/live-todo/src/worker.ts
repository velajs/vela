import { createCloudflareWorker } from '@velajs/cloudflare';
import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { AppModule } from './app.module';

// The same AppModule the node host runs. The Worker serves HTTP mutations and
// forwards upgrades; the Durable Object holds each room's sockets, re-runs live
// queries and keeps the cursor log. Each builds its own application from its
// own environment, whose TODOS and CHAT_ROOM bindings `wrangler types` types.

/** wrangler `class_name` — must be in `migrations[].new_sqlite_classes` (the cursor log lives in DO SQLite). */
export class LiveRoom extends VelaWebSocketDurableObject(AppModule) {}

export default createCloudflareWorker(AppModule);

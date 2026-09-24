import { VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import {
  Gateways,
  WebSocketGateway,
  WebSocketModule,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@velajs/vela/websocket';
import type {
  WsClient,
  WsServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  UpgradeAuthenticator,
  WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';

// ---- Upgrade authentication (DEMO ONLY) ----

/**
 * DEMO ONLY: admits every upgrade as a fresh anonymous visitor so the example
 * runs without an auth stack. Gateways reject upgrades that name no
 * `authenticator`; a real application verifies a session cookie or a
 * short-lived socket ticket here and returns that user's identity. The Worker
 * resolves this class through dependency injection, so a real authenticator
 * can inject its session service.
 */
@Injectable()
export class AnonymousDemoAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: {
        issuer: 'vela-ws-chat-demo',
        subject: `anonymous:${crypto.randomUUID()}`,
        principalType: 'user',
      },
      tenantId: 'demo',
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    };
  }
}

// ---- Gateway: one Durable Object per room; broadcast to everyone in it ----

/** The events the chat's rooms receive: each event name and its payload. */
export interface ChatEvents {
  chat: { from: string; text: string };
  system: { text: string };
}

@WebSocketGateway({
  path: '/rooms/:id/ws',
  roomParam: 'id',
  binding: 'CHAT_ROOM',
  authenticator: AnonymousDemoAuthenticator,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(@WebSocketServer() private readonly server: WsServer) {}

  handleConnection(client: WsClient) {
    const who = client.id.slice(0, 8);
    client.send('system', { text: `you are ${who}` });
    void this.server.emit('system', { text: `${who} joined` });
  }

  handleDisconnect(client: WsClient) {
    void this.server.emit('system', { text: `${client.id.slice(0, 8)} left` });
  }

  @SubscribeMessage('chat')
  onChat(@MessageBody() body: { text: string }, @ConnectedSocket() client: WsClient) {
    void this.server.emit('chat', { from: client.id.slice(0, 8), text: body.text });
    return { event: 'ack', data: { ok: true } }; // echoed back to the sender only
  }
}

// ---- Page: serve the browser client from the Worker (same origin) ----

const PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Vela WS Chat</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem}
  #log{border:1px solid #ccc;border-radius:8px;height:320px;overflow:auto;padding:.5rem;margin:.5rem 0;background:#fafafa}
  .m{margin:.15rem 0}.sys{color:#888;font-style:italic}.me{color:#0a7}.ack{color:#a0a;font-size:12px}
  form{display:flex;gap:.5rem}input{flex:1;padding:.5rem;border:1px solid #ccc;border-radius:6px}
  button{padding:.5rem .9rem;border:0;border-radius:6px;background:#0a7;color:#fff;cursor:pointer}
  #status{font-size:12px;color:#888}
</style></head><body>
<h2>Vela WebSocket · Cloudflare Durable Object</h2>
<div id="status">connecting…</div>
<div id="log"></div>
<form id="f"><input id="t" placeholder="message" autocomplete="off"><button>send</button></form>
<script>
  const log = document.getElementById('log'), status = document.getElementById('status');
  const add = (cls, txt) => { const d=document.createElement('div'); d.className='m '+cls; d.textContent=txt; log.appendChild(d); log.scrollTop=log.scrollHeight; };
  const url = (location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/rooms/general/ws';
  const ws = new WebSocket(url);
  ws.onopen = () => { status.textContent = 'connected: '+url; };
  ws.onclose = () => { status.textContent = 'disconnected'; };
  ws.onmessage = (e) => {
    const { event, data } = JSON.parse(e.data);
    if (event==='chat') add('', data.from+': '+data.text);
    else if (event==='system') add('sys', data.text);
    else if (event==='ack') add('ack', '✓ delivered');
  };
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const t = document.getElementById('t');
    if (!t.value) return;
    ws.send(JSON.stringify({ event:'chat', data:{ text: t.value } }));
    add('me', 'me: '+t.value);
    t.value='';
  };
</script></body></html>`;

@Controller()
export class PageController {
  @Get('/')
  index() {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

// ---- Server push: the Worker announces to a room through Gateways ----

/** Validates an announcement body before any of it reaches a room: 1 to 500 characters of text. */
const Announcement = {
  parse(value: unknown): { text: string } {
    const text: unknown =
      typeof value === 'object' && value !== null ? Reflect.get(value, 'text') : undefined;
    if (typeof text !== 'string' || text.length === 0 || text.length > 500) {
      throw new BadRequestException('An announcement needs text of 1 to 500 characters');
    }
    return { text };
  },
};

/**
 * The Worker holds no sockets; `Gateways` sends the push to the room's
 * `ChatRoom` Durable Object over its broadcast RPC. DEMO ONLY: anyone who can
 * reach this route can push into any room it names. A real application guards
 * it with its own authorization, for example `@UseGuards(StaffGuard)`.
 */
@Controller('/rooms')
export class AnnouncementController {
  constructor(private readonly gateways: Gateways) {}

  @Post('/:id/announce')
  async announce(@Param('id') room: string, @Body(Announcement) body: { text: string }) {
    const text = `announcement: ${body.text}`;
    await this.gateways.of<ChatEvents>(ChatGateway).to(room).emit('system', { text });
    return { announced: room };
  }
}

// ---- App module + Worker entry ----

@Module({
  imports: [WebSocketModule.forRoot()],
  controllers: [PageController, AnnouncementController],
  providers: [ChatGateway],
})
export class AppModule {}

// The Cloudflare adapter serves the gateway's upgrade route in the Worker and
// forwards it to the CHAT_ROOM Durable Object for the room, read by name from
// ENV; inside that object the same module broadcasts to the room's sockets, and
// Gateways pushes from the Worker reach it over its broadcast RPC.
export class ChatRoom extends VelaWebSocketDurableObject(AppModule) {}

export default createCloudflareWorker(AppModule);

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resendTransport } from '@velajs/mail/transports/resend';
import { cloudflareEmailTransport } from '@velajs/mail/transports/cloudflare';
import { createMailCatcher } from '@velajs/mail/transports/catcher';
import { assertCount, assertSent, extractLink } from '@velajs/mail/testing';

assert.equal(existsSync('node_modules/@velajs/vela'), false, 'standalone install pulled Vela');
const built = {
  from: { email: 'sender@example.com' },
  to: [{ email: 'to@example.com' }],
  cc: [],
  bcc: [],
  subject: 'hello',
  text: 'Visit https://example.com',
  headers: {},
  envelope: { from: 'sender@example.com', to: ['to@example.com'] },
};
const catcher = createMailCatcher();
await catcher.deliver(built);
assertCount(catcher, 1);
assert.equal(extractLink(assertSent(catcher, { to: 'to@example.com' })), 'https://example.com');
assert.equal(catcher.handler()(new Request('https://local.test')).status, 200);
const resend = resendTransport({
  apiKey: 'fixture',
  fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).subject, 'hello');
    return Response.json({ id: 'fixture-delivery' });
  },
});
assert.equal((await resend.deliver(built)).id, 'fixture-delivery');
const cloudflare = cloudflareEmailTransport({
  binding: {
    async send(message) {
      assert.deepEqual(message.to, ['to@example.com']);
      assert.equal(message.text, built.text);
      assert.equal(message.envelope, undefined);
      return { messageId: 'native-fixture' };
    },
  },
});
assert.deepEqual(await cloudflare.deliver(built), { id: 'native-fixture', provider: 'cloudflare' });

import assert from 'node:assert/strict';
import { Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import { inline, QueueModule } from '@velajs/vela/queue';
import {
  MailModule,
  MailService,
  OnInboundEmail,
  dispatchInboundEmail,
  parseInboundEmail,
  buildMessage,
  reparseBuiltWire,
  renderRawMessage,
} from '@velajs/mail';
import { createMailCatcher, assertCount } from '@velajs/mail/testing';

const catcher = createMailCatcher();
const driver = inline({ mode: 'manual' });
let received = 0;
let disposed = 0;
class Inbox {
  handle(email) {
    assert.equal(email.subject, 'hello');
    received++;
  }
  dispose() {
    disposed++;
  }
}
Injectable({ scope: Scope.REQUEST })(Inbox);
OnInboundEmail()(
  Inbox.prototype,
  'handle',
  Object.getOwnPropertyDescriptor(Inbox.prototype, 'handle'),
);
class App {}
Module({
  providers: [Inbox],
  imports: [
    QueueModule.forRoot({ queues: ['mail'], driver }),
    MailModule.forRoot({
      from: 'sender@example.com',
      transport: catcher,
      queue: {},
    }),
  ],
})(App);
const app = await VelaFactory.create(App);
try {
  const message = { to: 'to@example.com', subject: 'hello', text: 'world' };
  await app.get(MailService).send(message);
  await app.get(MailService).queue(message);
  await driver.flush();
  assertCount(catcher, 2);
  const built = await buildMessage(message, { from: 'sender@example.com' });
  assert.match(
    renderRawMessage(reparseBuiltWire(JSON.parse(JSON.stringify(built)))),
    /Subject: hello/,
  );
  assert.throws(() => reparseBuiltWire({ ...built, subject: 'evil\r\nBcc: hidden@example.com' }));
  const raw = 'From: sender@example.com\r\nTo: to@example.com\r\nSubject: hello\r\n\r\nworld';
  const rejected = await dispatchInboundEmail(
    app.getContainer(),
    app.entrypoints,
    parseInboundEmail(raw),
  );
  assert.equal(rejected.gated, true);
  const accepted = await dispatchInboundEmail(
    app.getContainer(),
    app.entrypoints,
    parseInboundEmail(raw, {
      verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
    }),
  );
  assert.equal(accepted.handled, 1);
  assert.equal(received, 1);
  assert.equal(disposed, 1);
} finally {
  await app.dispose();
}

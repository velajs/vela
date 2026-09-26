import { describe, expect, it, vi } from 'vitest';
import { buildMessage } from '../build';
import { MailError } from '../mail.error';
import {
  cloudflareEmailTransport,
  type CloudflareEmailBinding,
  type CloudflareEmailPayload,
} from '../transports/cloudflare';
import type { MailMessage } from '../types';

const message = (overrides: Partial<MailMessage> = {}) =>
  buildMessage(
    { to: 'reader@example.net', subject: 'Hello', text: 'Hello\nworld', ...overrides },
    { from: 'Sender <sender@example.com>' },
  );

describe('cloudflareEmailTransport', () => {
  it('preserves structured recipients, reply-to, bodies and headers in one native call', async () => {
    const built = await message({
      to: ['First <first@example.net>', 'second@example.net'],
      cc: 'Copy <copy@example.net>',
      bcc: 'private@example.net',
      replyTo: 'Help <help@example.com>',
      subject: 'Olá ✉',
      html: '<p>Olá</p>\n<p>Again</p>',
      text: '',
      headers: { 'X-Campaign': 'fixture', 'List-Id': 'letters.example.com' },
    });
    const before = structuredClone(built);
    const send = vi.fn<CloudflareEmailBinding['send']>(async () => ({ messageId: 'native-1' }));
    const result = await cloudflareEmailTransport({ binding: { send } }).deliver(built);
    expect(result).toEqual({ id: 'native-1', provider: 'cloudflare' });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'First', email: 'first@example.net' }, 'second@example.net'],
      cc: [{ name: 'Copy', email: 'copy@example.net' }],
      bcc: ['private@example.net'],
      replyTo: { name: 'Help', email: 'help@example.com' },
      subject: 'Olá ✉',
      html: '<p>Olá</p>\n<p>Again</p>',
      text: '',
      headers: { 'X-Campaign': 'fixture', 'List-Id': 'letters.example.com' },
    });
    // The provider cannot mutate the validated message shared with other consumers.
    const payload = send.mock.calls[0]![0];
    payload.to.push('extra@example.net');
    payload.headers!['X-Campaign'] = 'changed';
    if (typeof payload.from !== 'string') payload.from.name = 'Changed';
    expect(built).toEqual(before);
  });

  it.each([{ text: '' }, { html: '' }, { text: 'only text' }, { html: '<p>only html</p>' }])(
    'omits absent fields and preserves an explicitly empty body: %j',
    async (body) => {
      const built = await buildMessage(
        { from: 'sender@example.com', to: 'reader@example.net', subject: 'Hi', ...body },
        { from: 'unused@example.com' },
      );
      const send = vi.fn<CloudflareEmailBinding['send']>(async () => ({ messageId: 'native-2' }));
      await cloudflareEmailTransport({ binding: { send } }).deliver(built);
      expect(send).toHaveBeenCalledExactlyOnceWith({
        from: 'sender@example.com',
        to: ['reader@example.net'],
        subject: 'Hi',
        ...body,
      });
    },
  );

  it('keeps the binding receiver and snapshots the selected environment binding', async () => {
    const seen: CloudflareEmailPayload[] = [];
    const binding = {
      label: 'first',
      async send(payload: CloudflareEmailPayload) {
        seen.push(payload);
        return { messageId: this.label };
      },
    };
    const options = { binding };
    const first = cloudflareEmailTransport(options);
    options.binding = { ...binding, label: 'second' };
    const second = cloudflareEmailTransport(options);
    const built = await message();
    expect(await Promise.all([first.deliver(built), second.deliver(built)])).toEqual([
      { id: 'first', provider: 'cloudflare' },
      { id: 'second', provider: 'cloudflare' },
    ]);
    expect(seen).toHaveLength(2);
  });

  it('counts all to/cc/bcc entries and rejects 51 without splitting or sending', async () => {
    const send = vi.fn<CloudflareEmailBinding['send']>(async () => ({ messageId: 'fifty' }));
    const transport = cloudflareEmailTransport({ binding: { send } });
    const built = await message({
      to: Array.from({ length: 48 }, () => 'same@example.net'),
      cc: 'same@example.net',
      bcc: 'same@example.net',
    });
    expect(await transport.deliver(built)).toEqual({ id: 'fifty', provider: 'cloudflare' });
    built.bcc.push({ email: 'one-more@example.net' });
    await expect(transport.deliver(built)).rejects.toMatchObject({ code: 'invalid_message' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['E_SENDER_NOT_VERIFIED', 'E_RATE_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED'])(
    'redacts %s while preserving the original error and its code without retrying',
    async (code) => {
      const cause = Object.assign(new Error('Provider detail about private@example.net'), { code });
      const send = vi.fn<CloudflareEmailBinding['send']>(() => {
        throw cause;
      });
      const error = await cloudflareEmailTransport({ binding: { send } })
        .deliver(await message())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MailError);
      expect(error).toMatchObject({
        code: 'provider_error',
        internal: true,
        message: '@velajs/mail: email delivery failed',
        cause,
      });
      expect(error instanceof Error && error.cause).toBe(cause);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves asynchronous non-Error rejections as the cause', async () => {
    const cause = { code: 'E_INTERNAL_SERVER_ERROR', detail: 'fixture' };
    const transport = cloudflareEmailTransport({ binding: { send: () => Promise.reject(cause) } });
    await expect(transport.deliver(await message())).rejects.toMatchObject({
      code: 'provider_error',
      cause,
    });
  });

  it.each([undefined, null, {}, { messageId: 123 }, { messageId: '' }, []])(
    'does not invent an ID or retry after a fulfilled send with invalid tracking: %j',
    async (result) => {
      const send = vi.fn<CloudflareEmailBinding['send']>(async () => result);
      expect(
        await cloudflareEmailTransport({ binding: { send } }).deliver(await message()),
      ).toEqual({ provider: 'cloudflare' });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import { MailError } from '../mail.error';
import { resendTransport } from '../transports/resend';
import type { BuiltMessage } from '../types';

function built(overrides: Partial<BuiltMessage> = {}): BuiltMessage {
  return {
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'a@b.com' }],
    cc: [{ email: 'c@d.com' }],
    bcc: [],
    replyTo: { email: 'reply@example.com' },
    subject: 'Hello',
    html: '<b>hi</b>',
    text: 'hi',
    headers: { 'X-Tag': 'v' },
    envelope: { from: 'sender@example.com', to: ['a@b.com', 'c@d.com'] },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resendTransport', () => {
  it('POSTs the expected JSON body and returns the provider id on 2xx', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'msg_123' }));
    const transport = resendTransport({ apiKey: 'key_abc', fetch: fetchMock });

    const result = await transport.deliver(built());

    expect(result).toEqual({ id: 'msg_123', provider: 'resend' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer key_abc');
    expect(headers['content-type']).toBe('application/json');
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload.from).toBe('Sender <sender@example.com>');
    expect(payload.to).toEqual(['a@b.com']);
    expect(payload.cc).toEqual(['c@d.com']);
    expect(payload.reply_to).toBe('reply@example.com');
    expect(payload.subject).toBe('Hello');
    expect(payload.html).toBe('<b>hi</b>');
    expect(payload.headers).toEqual({ 'X-Tag': 'v' });
  });

  it('honors a custom baseUrl', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'x' }));
    const transport = resendTransport({
      apiKey: 'k',
      baseUrl: 'https://mail.internal/send',
      fetch: fetchMock,
    });
    await transport.deliver(built());
    expect(fetchMock.mock.calls[0]![0]).toBe('https://mail.internal/send');
  });

  it('throws a redacted provider_error on a non-2xx response', async () => {
    const secret = 'PROVIDER SAID: invalid api key sk_live_supersecret';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(secret, { status: 422 }));
    const transport = resendTransport({ apiKey: 'k', fetch: fetchMock });

    let thrown: unknown;
    try {
      await transport.deliver(built());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MailError);
    const error = thrown as MailError;
    expect(error.code).toBe('provider_error');
    expect(error.internal).toBe(true);
    expect(error.status).toBe(422);
    // The client-safe message is the fixed string; the provider body is NOT in it.
    expect(error.message).toBe('@velajs/mail: email delivery failed');
    expect(error.message).not.toContain('supersecret');
    // The raw body is preserved only in `cause` for server-side logs.
    expect(error.cause).toBe(secret);
  });

  it('throws a redacted provider_error on a network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    });
    const transport = resendTransport({ apiKey: 'k', fetch: fetchMock });

    let thrown: unknown;
    try {
      await transport.deliver(built());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MailError);
    const error = thrown as MailError;
    expect(error.code).toBe('provider_error');
    expect(error.internal).toBe(true);
    expect(error.message).toBe('@velajs/mail: email delivery failed');
    expect(error.message).not.toContain('ECONNREFUSED');
  });
});

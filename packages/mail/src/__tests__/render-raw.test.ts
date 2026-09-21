import { describe, expect, it } from 'vitest';
import { renderRawMessage } from '../render-raw';
import type { BuiltMessage } from '../types';

function base(overrides: Partial<BuiltMessage> = {}): BuiltMessage {
  return {
    from: { email: 'sender@example.com' },
    to: [{ email: 'a@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Hello',
    headers: {},
    envelope: { from: 'sender@example.com', to: ['a@b.com'] },
    ...overrides,
  };
}

/** Everything up to the first blank line is the header block. */
function headerBlock(raw: string): string {
  const idx = raw.indexOf('\r\n\r\n');
  return idx === -1 ? raw : raw.slice(0, idx);
}

describe('renderRawMessage', () => {
  it('uses CRLF line endings', () => {
    const raw = renderRawMessage(base({ text: 'body' }));
    expect(raw.includes('\r\n')).toBe(true);
    // No lone LF that is not preceded by CR anywhere in the header block.
    const headers = headerBlock(raw);
    expect(/[^\r]\n/.test(headers)).toBe(false);
  });

  it('RFC 2047 encodes a non-ASCII subject', () => {
    const raw = renderRawMessage(base({ subject: 'Rêsumé ✓', text: 'x' }));
    expect(raw).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it('RFC 2047 encodes a non-ASCII display name', () => {
    const raw = renderRawMessage(base({ from: { email: 'a@b.com', name: 'Zoë' }, text: 'x' }));
    expect(raw).toMatch(/From: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <a@b.com>/);
  });

  it('leaves an ASCII subject unencoded', () => {
    const raw = renderRawMessage(base({ subject: 'Plain subject', text: 'x' }));
    expect(raw).toContain('Subject: Plain subject');
  });

  it('emits multipart/alternative when both html and text are present', () => {
    const raw = renderRawMessage(base({ html: '<b>h</b>', text: 't' }));
    expect(raw).toContain('Content-Type: multipart/alternative; boundary=');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
  });

  it('emits a single text/html part for an html-only message', () => {
    const raw = renderRawMessage(base({ html: '<b>h</b>' }));
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).not.toContain('multipart/alternative');
  });

  it('synthesizes Date and Message-ID when absent', () => {
    const raw = renderRawMessage(base({ text: 'x' }));
    expect(raw).toMatch(/\r\nDate: /);
    expect(raw).toMatch(/\r\nMessage-ID: <[^>]+@example\.com>/);
  });

  it('does not synthesize Date/Message-ID when supplied as custom headers', () => {
    const raw = renderRawMessage(
      base({
        text: 'x',
        headers: { Date: 'Wed, 01 Jan 2020 00:00:00 GMT', 'Message-ID': '<x@y>' },
      }),
    );
    expect(raw.match(/\r\nDate: /g)?.length).toBe(1);
    expect(raw).toContain('Message-ID: <x@y>');
  });

  it('never leaves an unencoded newline in the header block (golden shape)', () => {
    const raw = renderRawMessage(
      base({
        subject: 'Weekly report',
        from: { email: 'sender@example.com', name: 'Reports' },
        to: [{ email: 'a@b.com' }],
        cc: [{ email: 'c@d.com', name: 'Carol' }],
        headers: { 'X-Tag': 'weekly' },
        html: '<h1>Hi</h1>',
        text: 'Hi',
      }),
    );
    const headers = headerBlock(raw);
    // Each physical header line must be CRLF-terminated: no bare LF.
    expect(/[^\r]\n/.test(headers)).toBe(false);
    expect(headers).toContain('From: Reports <sender@example.com>');
    expect(headers).toContain('To: a@b.com');
    expect(headers).toContain('Cc: Carol <c@d.com>');
    expect(headers).toContain('X-Tag: weekly');
  });
});

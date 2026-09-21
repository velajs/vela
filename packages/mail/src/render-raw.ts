import type { Address, BuiltMessage } from './types';

const CRLF = '\r\n';

/** Base64 of a string's UTF-8 bytes (edge-safe: TextEncoder + btoa over a binary string). */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const NON_ASCII = /[^\u0020-\u007E]/;

/** RFC 2047 `=?utf-8?B?…?=` encoded-word for a header value containing non-ASCII. */
function encodeWordIfNeeded(value: string): string {
  return NON_ASCII.test(value) ? `=?utf-8?B?${base64Utf8(value)}?=` : value;
}

/** Format an address for a header: `Encoded-Name <addr>` or a bare `addr`. */
function formatAddress(a: Address): string {
  if (a.name === undefined || a.name.length === 0) return a.email;
  return `${encodeWordIfNeeded(a.name)} <${a.email}>`;
}

function formatAddressList(list: Address[]): string {
  return list.map(formatAddress).join(', ');
}

/** Normalize any lone LF/CR in a body to CRLF (bodies never reach header context). */
function normalizeBody(body: string): string {
  return body.replace(/\r\n|\r|\n/g, CRLF);
}

/** A boundary token for multipart bodies — random, ASCII-only, never in guarded content. */
function makeBoundary(): string {
  return `----=_velajs_${crypto.randomUUID().replace(/-/g, '')}`;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : 'localhost';
}

/**
 * Assemble a raw RFC 822 / 2045 message from a {@link BuiltMessage} for
 * application-authored raw/SMTP-style transports. Non-ASCII header values (subject, display names) are RFC 2047
 * encoded-word encoded; `multipart/alternative` is used when both an HTML and a
 * text body are present, otherwise a single part. `Date` and `Message-ID` are
 * synthesized if absent. Every input has already cleared the guards, so this
 * assembly cannot inject a header.
 */
export function renderRawMessage(built: BuiltMessage): string {
  const lines: string[] = [];
  lines.push(`From: ${formatAddress(built.from)}`);
  lines.push(`To: ${formatAddressList(built.to)}`);
  if (built.cc.length > 0) lines.push(`Cc: ${formatAddressList(built.cc)}`);
  if (built.replyTo !== undefined) lines.push(`Reply-To: ${formatAddress(built.replyTo)}`);
  lines.push(`Subject: ${encodeWordIfNeeded(built.subject)}`);

  const hasHeader = (name: string): boolean =>
    Object.keys(built.headers).some((h) => h.toLowerCase() === name);
  if (!hasHeader('date')) lines.push(`Date: ${new Date().toUTCString()}`);
  if (!hasHeader('message-id')) {
    lines.push(`Message-ID: <${crypto.randomUUID()}@${domainOf(built.from.email)}>`);
  }
  for (const [name, value] of Object.entries(built.headers)) lines.push(`${name}: ${value}`);
  lines.push('MIME-Version: 1.0');

  const html = built.html;
  const text = built.text;

  if (html !== undefined && text !== undefined) {
    const boundary = makeBoundary();
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeBody(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeBody(html),
      `--${boundary}--`,
      '',
    ];
    return [...lines, ...parts].join(CRLF);
  }

  const single = html ?? text ?? '';
  const contentType = html !== undefined ? 'text/html' : 'text/plain';
  lines.push(`Content-Type: ${contentType}; charset=utf-8`);
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(normalizeBody(single));
  return lines.join(CRLF);
}

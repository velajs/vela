import {
  assertAllowedCustomHeaderName,
  assertSafeHeaderValue,
  assertSafeSubject,
  parseAddress,
} from './address';
import { MailError } from './mail.error';
import { enforceBuiltMessageLimits, type MailLimits, resolveMailLimits } from './limits';
import type { Address, BuiltMessage } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reparseAddress(value: unknown): Address {
  if (!isRecord(value) || typeof value.email !== 'string') {
    throw new MailError('invalid_message', '@velajs/mail: queued message has a malformed address');
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw new MailError('invalid_message', '@velajs/mail: queued address name is not a string');
  }
  const input =
    typeof value.name === 'string'
      ? { email: value.email, name: value.name }
      : { email: value.email };
  // parseAddress re-runs the full address + header-injection guard set.
  return parseAddress(input);
}

function reparseList(value: unknown): Address[] {
  if (!Array.isArray(value)) {
    throw new MailError(
      'invalid_message',
      '@velajs/mail: queued message has a malformed recipient list',
    );
  }
  return value.map(reparseAddress);
}

function reparseBody(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new MailError('invalid_message', `@velajs/mail: queued message ${field} is not a string`);
  }
  return value;
}

/**
 * Re-validate an untrusted dequeued wire back into a fresh {@link BuiltMessage}.
 *
 * The queue is a trust boundary: a compromised producer or queue could land
 * arbitrary JSON in `job.data`. This re-runs the SAME guards `buildMessage` ran
 * before enqueue — `parseAddress` on every address, `assertSafeSubject`,
 * `assertSafeHeaderName`/`assertSafeHeaderValue` on every header — and rebuilds
 * the envelope from scratch. A poisoned payload is rejected here, on dequeue,
 * before it can reach any transport.
 */
export function reparseBuiltWire(data: unknown, overrides?: Partial<MailLimits>): BuiltMessage {
  const limits = resolveMailLimits(overrides);
  if (!isRecord(data)) {
    throw new MailError('invalid_message', '@velajs/mail: queued message is not an object');
  }

  if (typeof data.subject !== 'string') {
    throw new MailError('invalid_message', '@velajs/mail: queued message subject is not a string');
  }
  assertSafeSubject(data.subject);

  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  if (data.headers !== undefined) {
    if (!isRecord(data.headers)) {
      throw new MailError('invalid_message', '@velajs/mail: queued message headers are malformed');
    }
    const entries = Object.entries(data.headers);
    if (entries.length > limits.maxHeaders) {
      throw new MailError(
        'invalid_header',
        `@velajs/mail: queued message exceeds ${limits.maxHeaders} custom headers`,
      );
    }
    for (const [name, value] of entries) {
      if (typeof value !== 'string') {
        throw new MailError(
          'invalid_message',
          `@velajs/mail: queued header "${name}" is not a string`,
        );
      }
      assertAllowedCustomHeaderName(name);
      assertSafeHeaderValue(name, value);
      headers[name] = value;
    }
  }

  const recipientValues = [data.to, data.cc ?? [], data.bcc ?? []];
  let recipientCount = 0;
  for (const value of recipientValues) {
    if (!Array.isArray(value)) {
      throw new MailError(
        'invalid_message',
        '@velajs/mail: queued message has a malformed recipient list',
      );
    }
    recipientCount += value.length;
  }
  if (recipientCount > limits.maxRecipients) {
    throw new MailError(
      'invalid_message',
      `@velajs/mail: queued message exceeds ${limits.maxRecipients} recipients`,
    );
  }

  const from = reparseAddress(data.from);
  const to = reparseList(data.to);
  const cc = data.cc === undefined ? [] : reparseList(data.cc);
  const bcc = data.bcc === undefined ? [] : reparseList(data.bcc);
  const replyTo = data.replyTo === undefined ? undefined : reparseAddress(data.replyTo);
  const html = reparseBody(data.html, 'html');
  const text = reparseBody(data.text, 'text');

  if (to.length === 0) {
    throw new MailError('invalid_message', '@velajs/mail: queued message has no recipients');
  }
  if (html === undefined && text === undefined) {
    throw new MailError('invalid_message', '@velajs/mail: queued message has no body');
  }

  const seen = new Set<string>();
  const envelopeTo: string[] = [];
  for (const a of [...to, ...cc, ...bcc]) {
    if (seen.has(a.email)) continue;
    seen.add(a.email);
    envelopeTo.push(a.email);
  }

  const built: BuiltMessage = {
    from,
    to,
    cc,
    bcc,
    subject: data.subject,
    headers,
    envelope: { from: from.email, to: envelopeTo },
  };
  if (replyTo !== undefined) built.replyTo = replyTo;
  if (html !== undefined) built.html = html;
  if (text !== undefined) built.text = text;
  enforceBuiltMessageLimits(built, limits);
  return built;
}

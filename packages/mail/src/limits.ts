import { MailError } from './mail.error';
import type { Address, BuiltMessage } from './types';

export interface MailLimits {
  /** Maximum total To/Cc/Bcc entries. */
  maxRecipients: number;
  /** Maximum number of caller-provided headers. */
  maxHeaders: number;
  /** Maximum UTF-8 bytes across generated and caller-provided header values. */
  maxHeaderBytes: number;
  /** Maximum UTF-8 bytes across text and HTML bodies. */
  maxBodyBytes: number;
  /** Maximum approximate UTF-8 bytes for the normalized message. */
  maxMessageBytes: number;
}

export const DEFAULT_MAIL_LIMITS: Readonly<MailLimits> = Object.freeze({
  maxRecipients: 100,
  maxHeaders: 50,
  maxHeaderBytes: 64 * 1024,
  maxBodyBytes: 2 * 1024 * 1024,
  maxMessageBytes: 3 * 1024 * 1024,
});

export function resolveMailLimits(overrides?: Partial<MailLimits>): MailLimits {
  const limits = { ...DEFAULT_MAIL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MailError(
        'invalid_message',
        `@velajs/mail: security limit ${name} must be a positive integer`,
      );
    }
  }
  return limits;
}

const encoder = new TextEncoder();

function bytes(value: string | undefined): number {
  return value === undefined ? 0 : encoder.encode(value).byteLength;
}

function addressBytes(address: Address | undefined): number {
  return address === undefined ? 0 : bytes(address.email) + bytes(address.name);
}

/** Enforce all normalized-message limits immediately before a trust-boundary handoff. */
export function enforceBuiltMessageLimits(message: BuiltMessage, limits: MailLimits): void {
  const recipients = message.to.length + message.cc.length + message.bcc.length;
  if (recipients > limits.maxRecipients) {
    throw new MailError(
      'invalid_message',
      `@velajs/mail: message exceeds ${limits.maxRecipients} recipients`,
    );
  }

  const customHeaders = Object.entries(message.headers);
  if (customHeaders.length > limits.maxHeaders) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: message exceeds ${limits.maxHeaders} custom headers`,
    );
  }

  const bodyBytes = bytes(message.html) + bytes(message.text);
  if (bodyBytes > limits.maxBodyBytes) {
    throw new MailError(
      'invalid_message',
      `@velajs/mail: message body exceeds ${limits.maxBodyBytes} bytes`,
    );
  }

  let headerBytes =
    bytes(message.subject) + addressBytes(message.from) + addressBytes(message.replyTo);
  for (const address of [...message.to, ...message.cc, ...message.bcc]) {
    headerBytes += addressBytes(address);
  }
  for (const [name, value] of customHeaders) headerBytes += bytes(name) + bytes(value);
  if (headerBytes > limits.maxHeaderBytes) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: message headers exceed ${limits.maxHeaderBytes} bytes`,
    );
  }
  if (headerBytes + bodyBytes > limits.maxMessageBytes) {
    throw new MailError(
      'invalid_message',
      `@velajs/mail: message exceeds ${limits.maxMessageBytes} bytes`,
    );
  }
}

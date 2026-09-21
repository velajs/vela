import { MailError } from './mail.error';
import type { Address, AddressInput } from './types';

// Length ceilings. Emails are capped at the RFC 5321 path limit; the others are
// conservative bounds that keep a single header line sane and bound regex work.
export const MAX_EMAIL_LENGTH = 320;
export const MAX_NAME_LENGTH = 256;
export const MAX_HEADER_VALUE_LENGTH = 8192;
export const MAX_SUBJECT_LENGTH = 998;

/**
 * Code points that must never reach header context. Beyond the obvious CR
 * (U+000D), LF (U+000A) and NUL (U+0000) that split a header line, we reject the
 * Unicode newline family — NEL (U+0085), LINE SEPARATOR (U+2028), PARAGRAPH
 * SEPARATOR (U+2029): a downstream charset transcoder or a naive line-splitter
 * can fold these into real CR/LF after our check, so we treat them as line
 * breaks up front (defense in depth). Percent- and entity-encoded forms are
 * deliberately NOT decoded — as literal bytes in a header value they are inert;
 * only a true control byte splits a header.
 */
const FORBIDDEN_CODE_POINTS = /[\u0000\u000A\u000D\u0085\u2028\u2029]/;

/** RFC 5322 ftext: printable ASCII 33–126 excluding ':' (58). No space, no controls. */
const HEADER_NAME = /^[!-9;-~]+$/;

const RESERVED_CUSTOM_HEADERS = new Set([
  'authentication-results',
  'bcc',
  'cc',
  'content-transfer-encoding',
  'content-type',
  'date',
  'delivered-to',
  'dkim-signature',
  'errors-to',
  'from',
  'in-reply-to',
  'message-id',
  'mime-version',
  'received',
  'references',
  'reply-to',
  'return-path',
  'sender',
  'subject',
  'to',
]);

function hasForbidden(value: string): boolean {
  return FORBIDDEN_CODE_POINTS.test(value);
}

/**
 * Reject a header VALUE carrying any forbidden code point or exceeding the value
 * ceiling. Commas are allowed here (a multi-value header is legitimate).
 */
export function assertSafeHeaderValue(label: string, value: string): void {
  if (hasForbidden(value)) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: header "${label}" contains a line break or control character`,
    );
  }
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: header "${label}" exceeds ${MAX_HEADER_VALUE_LENGTH} characters`,
    );
  }
}

/**
 * Reject a custom header NAME that is not RFC 5322 ftext — blocks CR/LF, spaces,
 * a colon, and control characters in the key, and rejects an empty name.
 */
export function assertSafeHeaderName(name: string): void {
  if (!HEADER_NAME.test(name)) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: header name "${name}" is not a valid RFC 5322 field name`,
    );
  }
}

/** Reject headers controlled by the mailer, transport, or receiving MTA. */
export function assertAllowedCustomHeaderName(name: string): void {
  assertSafeHeaderName(name);
  const lower = name.toLowerCase();
  if (
    RESERVED_CUSTOM_HEADERS.has(lower) ||
    lower.startsWith('arc-') ||
    lower.startsWith('content-') ||
    lower.startsWith('resent-')
  ) {
    throw new MailError('invalid_header', `@velajs/mail: custom header "${name}" is reserved`);
  }
}

/**
 * Reject an address-field component (a display name or an email) that carries a
 * forbidden code point, a comma (which could smuggle a second SMTP recipient
 * past per-field validation), or an angle bracket (which would break the
 * bracketed display form); also enforce the field's length ceiling.
 */
function assertSafeAddressField(label: string, value: string, maxLength: number): void {
  if (hasForbidden(value)) {
    throw new MailError(
      'invalid_address',
      `@velajs/mail: address ${label} contains a line break or control character`,
    );
  }
  if (value.includes(',')) {
    throw new MailError('invalid_address', `@velajs/mail: address ${label} contains a comma`);
  }
  if (value.includes('<') || value.includes('>')) {
    throw new MailError(
      'invalid_address',
      `@velajs/mail: address ${label} contains an angle bracket`,
    );
  }
  if (value.length > maxLength) {
    throw new MailError(
      'invalid_address',
      `@velajs/mail: address ${label} exceeds ${maxLength} characters`,
    );
  }
}

// Bracketed display form: everything before '<' is the name, everything between
// '<' and '>' is the address. The two character classes are disjoint (no '<'
// inside the name, no '>' inside the address), so there is no backtracking.
const BRACKETED = /^([^<]*)<([^>]*)>\s*$/;

/**
 * Minimal structural email check: exactly one `@`, a non-empty local part and
 * domain, no whitespace, within the length cap. Deliberately permissive —
 * over-strict email regexes reject valid addresses; the header-injection guards
 * (run separately) are what enforce safety.
 */
function assertPlausibleEmail(email: string): void {
  const at = email.indexOf('@');
  const looksStructural =
    at > 0 &&
    at === email.lastIndexOf('@') &&
    at < email.length - 1 &&
    !/\s/.test(email) &&
    email.length <= MAX_EMAIL_LENGTH;
  if (!looksStructural) {
    throw new MailError('invalid_address', `@velajs/mail: "${email}" is not a valid email address`);
  }
}

/**
 * Parse and guard a single address. Accepts an `{ email, name? }` object, a
 * bracketed `Display <addr>` string, or a bare `addr` string. Every branch runs
 * the address-field guards on both the email and the name, and a structural
 * email check.
 */
export function parseAddress(input: AddressInput): Address {
  let email: string;
  let name: string | undefined;

  if (typeof input === 'object') {
    if (
      input === null ||
      Array.isArray(input) ||
      typeof input.email !== 'string' ||
      (input.name !== undefined && typeof input.name !== 'string')
    ) {
      throw new MailError('invalid_address', '@velajs/mail: address object is malformed');
    }
    email = input.email.trim();
    name = input.name?.trim();
  } else if (typeof input === 'string') {
    const bracketed = BRACKETED.exec(input);
    if (bracketed) {
      name = bracketed[1]!.trim();
      email = bracketed[2]!.trim();
    } else {
      email = input.trim();
    }
  } else {
    throw new MailError('invalid_address', '@velajs/mail: address must be a string or object');
  }

  if (name !== undefined && name.length > 0) {
    assertSafeAddressField('name', name, MAX_NAME_LENGTH);
  } else {
    name = undefined;
  }
  assertSafeAddressField('email', email, MAX_EMAIL_LENGTH);
  assertPlausibleEmail(email);

  return name === undefined ? { email } : { email, name };
}

/** Parse a single address or a list; a single input becomes a one-element list. */
export function parseAddressList(input: AddressInput | AddressInput[]): Address[] {
  return (Array.isArray(input) ? input : [input]).map(parseAddress);
}

/** Guard a subject line: header-value safe plus the RFC 5322 line-length cap. */
export function assertSafeSubject(subject: string): void {
  assertSafeHeaderValue('subject', subject);
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new MailError(
      'invalid_header',
      `@velajs/mail: subject exceeds ${MAX_SUBJECT_LENGTH} characters`,
    );
  }
}

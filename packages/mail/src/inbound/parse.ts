import { assertSafeHeaderName, assertSafeHeaderValue } from '../address';
import { MailError } from '../mail.error';

/** A single mechanism verdict; `null` means the mechanism was not reported. */
export type Verdict =
  | 'pass'
  | 'fail'
  | 'neutral'
  | 'softfail'
  | 'none'
  | 'temperror'
  | 'permerror'
  | null;

export interface InboundAuthentication {
  dkim: Verdict;
  spf: Verdict;
  dmarc: Verdict;
}

export interface InboundEmail {
  /** The `From` header value — SPOOFABLE; never authorize on this. */
  from: string;
  /** `To` (and `Cc`) addresses, each already CRLF-checked. */
  to: string[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** Lowercased header keys, last value wins; every value is CRLF-checked. */
  headers: Record<string, string>;
  /** Verified verdicts only; untrusted raw headers never populate this object. */
  authentication: InboundAuthentication;
  authenticationSource: 'adapter' | 'authserv-id' | 'none';
  /** Adapter-supplied SMTP envelope (undefined for a pure header parse). */
  envelope?: { from: string; to: string };
  /** The full raw bytes — for BYO full-MIME parsing (bodies, attachments). */
  raw(): Uint8Array;
  /** UTF-8 decode of {@link InboundEmail.raw}. */
  rawText(): string;
}

const KNOWN_VERDICTS = new Set<string>([
  'pass',
  'fail',
  'neutral',
  'softfail',
  'none',
  'temperror',
  'permerror',
]);

function isKnownVerdict(value: unknown): value is Exclude<Verdict, null> {
  return typeof value === 'string' && KNOWN_VERDICTS.has(value);
}

export interface InboundMailLimits {
  maxMessageBytes: number;
  maxHeaderBytes: number;
  maxHeaders: number;
  maxRecipients: number;
}

export const DEFAULT_INBOUND_MAIL_LIMITS: Readonly<InboundMailLimits> = Object.freeze({
  maxMessageBytes: 25 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxHeaders: 200,
  maxRecipients: 100,
});

export interface ParseInboundEmailOptions {
  envelope?: { from: string; to: string };
  /** Authentication verdicts supplied by a trusted adapter/API, not message headers. */
  verifiedAuthentication?: InboundAuthentication;
  /** Exact authserv-ids allowed to authenticate the topmost Authentication-Results header. */
  trustedAuthservIds?: readonly string[];
  limits?: Partial<InboundMailLimits>;
}

function resolveInboundLimits(overrides?: Partial<InboundMailLimits>): InboundMailLimits {
  const limits = { ...DEFAULT_INBOUND_MAIL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MailError(
        'inbound_malformed',
        `@velajs/mail: inbound limit ${name} must be a positive integer`,
      );
    }
  }
  return limits;
}

function normalizeVerdict(token: string): Exclude<Verdict, null> {
  const lowered = token.toLowerCase();
  // Any unrecognized token is treated as a hard failure (fail-closed).
  return isKnownVerdict(lowered) ? lowered : 'permerror';
}

function validateVerifiedAuthentication(value: unknown): InboundAuthentication {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MailError(
      'inbound_malformed',
      '@velajs/mail: adapter supplied malformed authentication verdicts',
    );
  }
  const out: InboundAuthentication = { dkim: null, spf: null, dmarc: null };
  for (const mechanism of ['dkim', 'spf', 'dmarc'] as const) {
    const verdict: unknown = Reflect.get(value, mechanism);
    if (verdict === null) continue;
    if (!isKnownVerdict(verdict)) {
      throw new MailError(
        'inbound_malformed',
        `@velajs/mail: adapter supplied an invalid ${mechanism} verdict`,
      );
    }
    out[mechanism] = verdict;
  }
  return out;
}

/**
 * Parse top-level `Authentication-Results` clauses. Quoted strings and comments
 * are skipped while finding semicolons, and only a mechanism assignment at the
 * beginning of a clause is accepted. Text such as
 * `reason="dmarc=pass"; dmarc=fail` can therefore never forge a pass verdict.
 */
function parseAuthenticationResults(value: string): InboundAuthentication {
  const auth: InboundAuthentication = { dkim: null, spf: null, dmarc: null };
  for (const clause of splitAuthenticationClauses(value).slice(1)) {
    const match = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z0-9]+)\b/i.exec(clause);
    if (match === null) continue;
    const mechanism = match[1]!.toLowerCase();
    const verdict = normalizeVerdict(match[2]!);
    if (mechanism === 'dkim' && auth.dkim === null) auth.dkim = verdict;
    else if (mechanism === 'spf' && auth.spf === null) auth.spf = verdict;
    else if (mechanism === 'dmarc' && auth.dmarc === null) auth.dmarc = verdict;
  }
  return auth;
}

function splitAuthenticationClauses(value: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let commentDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && (quoted || commentDepth > 0)) {
      escaped = true;
      continue;
    }
    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === '(') {
      commentDepth += 1;
      continue;
    }
    if (!quoted && character === ')' && commentDepth > 0) {
      commentDepth -= 1;
      continue;
    }
    if (!quoted && commentDepth === 0 && character === ';') {
      clauses.push(value.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(value.slice(start));
  return clauses;
}

function toBytes(raw: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (raw instanceof Uint8Array) return raw.slice();
  return new Uint8Array(raw).slice();
}

/** One logical header after continuation lines have been unfolded. */
interface ParsedHeader {
  key: string;
  value: string;
}

/**
 * Split the header block into unfolded `{ key, value }` entries in document
 * order. Physical lines are split on CRLF / LF only — a LONE CR is left inside
 * the line so the CRLF guard rejects it. Continuation lines (leading SP/HTAB)
 * are appended to the previous header's value.
 */
function parseHeaderBlock(block: string): ParsedHeader[] {
  const physical = block.split(/\r\n|\n/);
  const logical: string[] = [];
  for (const line of physical) {
    if (line.length === 0) continue;
    const first = line.charCodeAt(0);
    const isContinuation = (first === 0x20 || first === 0x09) && logical.length > 0;
    if (isContinuation) logical[logical.length - 1] += line;
    else logical.push(line);
  }

  const headers: ParsedHeader[] = [];
  for (const line of logical) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // no field name — skip
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    assertSafeHeaderName(key);
    assertSafeHeaderValue(key, value);
    headers.push({ key, value });
  }
  return headers;
}

function authservId(value: string): string | undefined {
  const separator = value.indexOf(';');
  if (separator <= 0) return undefined;
  const id = value.slice(0, separator).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(id) ? id : undefined;
}

function splitAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse a raw inbound message at the HEADER level only (no MIME body/attachment
 * decode; `raw()`/`rawText()` expose the bytes for BYO full-MIME parsing). The
 * authentication verdicts come from the TOPMOST `Authentication-Results` header
 * in document order — NOT from a `Headers`-collapsed view — so an attacker who
 * injects a second, lower `Authentication-Results` cannot override the verdict
 * the receiving MTA stamped on top.
 */
export function parseInboundEmail(
  raw: Uint8Array | ArrayBuffer | string,
  options: ParseInboundEmailOptions = {},
): InboundEmail {
  const limits = resolveInboundLimits(options.limits);
  const bytes = toBytes(raw);
  if (bytes.byteLength > limits.maxMessageBytes) {
    throw new MailError(
      'inbound_malformed',
      `@velajs/mail: inbound message exceeds ${limits.maxMessageBytes} bytes`,
    );
  }
  const text = new TextDecoder().decode(bytes);

  const blankMatch = /\r\n\r\n|\n\n/.exec(text);
  if (!blankMatch) {
    throw new MailError(
      'inbound_malformed',
      '@velajs/mail: inbound message has no header/body separator',
    );
  }
  const headerBlock = text.slice(0, blankMatch.index);
  if (new TextEncoder().encode(headerBlock).byteLength > limits.maxHeaderBytes) {
    throw new MailError(
      'inbound_malformed',
      `@velajs/mail: inbound headers exceed ${limits.maxHeaderBytes} bytes`,
    );
  }
  const parsed = parseHeaderBlock(headerBlock);
  if (parsed.length > limits.maxHeaders) {
    throw new MailError(
      'inbound_malformed',
      `@velajs/mail: inbound message exceeds ${limits.maxHeaders} headers`,
    );
  }

  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  let topAuthResults: string | undefined;
  for (const { key, value } of parsed) {
    if (key === 'authentication-results' && topAuthResults === undefined) {
      topAuthResults = value; // topmost wins
      continue; // security verdict headers are quarantined from public headers
    }
    if (key === 'authentication-results') continue;
    headers[key] = value; // last-wins
  }

  let authentication: InboundAuthentication = { dkim: null, spf: null, dmarc: null };
  let authenticationSource: InboundEmail['authenticationSource'] = 'none';
  if (options.verifiedAuthentication !== undefined) {
    authentication = validateVerifiedAuthentication(options.verifiedAuthentication);
    authenticationSource = 'adapter';
  } else if (topAuthResults !== undefined) {
    const trusted = new Set(
      (options.trustedAuthservIds ?? []).map((value) => value.trim().toLowerCase()),
    );
    const reportedBy = authservId(topAuthResults);
    if (reportedBy !== undefined && trusted.has(reportedBy)) {
      authentication = parseAuthenticationResults(topAuthResults);
      authenticationSource = 'authserv-id';
    }
  }

  const recipients = [...splitAddresses(headers.to ?? ''), ...splitAddresses(headers.cc ?? '')];
  if (recipients.length > limits.maxRecipients) {
    throw new MailError(
      'inbound_malformed',
      `@velajs/mail: inbound message exceeds ${limits.maxRecipients} recipients`,
    );
  }

  const email: InboundEmail = {
    from: headers.from ?? '',
    to: recipients,
    headers,
    authentication,
    authenticationSource,
    raw: () => bytes.slice(),
    rawText: () => new TextDecoder().decode(bytes),
  };
  if (headers.subject !== undefined) email.subject = headers.subject;
  if (headers['message-id'] !== undefined) email.messageId = headers['message-id'];
  if (headers['in-reply-to'] !== undefined) email.inReplyTo = headers['in-reply-to'];
  if (headers.references !== undefined) email.references = headers.references;
  if (options.envelope !== undefined) {
    const { from, to } = options.envelope;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new MailError('inbound_malformed', '@velajs/mail: malformed SMTP envelope');
    }
    assertSafeHeaderValue('envelope-from', from);
    assertSafeHeaderValue('envelope-to', to);
    email.envelope = { from, to };
  }
  return email;
}

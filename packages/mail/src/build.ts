import {
  assertAllowedCustomHeaderName,
  assertSafeHeaderValue,
  assertSafeSubject,
  parseAddress,
  parseAddressList,
} from './address';
import { MailError } from './mail.error';
import { enforceBuiltMessageLimits, type MailLimits, resolveMailLimits } from './limits';
import type { Address, AddressInput, BuiltMessage, MailMessage, RenderSeam } from './types';

export interface BuildOptions {
  /** The mailer's default `from`, used when a message omits its own. */
  from: AddressInput;
  /** Optional template renderer; required only when a message carries `template`. */
  render?: RenderSeam;
  /** Explicit security-limit overrides; omitted fields retain secure defaults. */
  limits?: Partial<MailLimits>;
}

/** Deduplicate recipients by email (case-insensitive local reuse of the raw email). */
function uniqueEmails(addresses: Address[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    if (seen.has(a.email)) continue;
    seen.add(a.email);
    out.push(a.email);
  }
  return out;
}

/**
 * The outbound pipeline: `render → validate → build`. Dispatch (the transport
 * call) is a separate step so guards are guaranteed to have run before ANY
 * transport — including the queue path — sees the message.
 *
 * 1. RENDER — if `template` is present and a {@link RenderSeam} is configured,
 *    render it; explicit `html`/`text` always win over the rendered result. A
 *    `template` with no configured renderer is a hard error.
 * 2. VALIDATE — subject, custom header names+values, and every address run
 *    through the injection guards; an empty `to` or a body-less message throws.
 * 3. BUILD — assemble a normalized, deterministic {@link BuiltMessage} with the
 *    envelope derived from the union of to+cc+bcc.
 */
export async function buildMessage(msg: MailMessage, opts: BuildOptions): Promise<BuiltMessage> {
  const limits = resolveMailLimits(opts.limits);
  if (typeof msg.subject !== 'string') {
    throw new MailError('invalid_header', '@velajs/mail: subject must be a string');
  }
  // 1. RENDER
  let html = msg.html;
  let text = msg.text;
  if (msg.template !== undefined) {
    if (!opts.render) {
      throw new MailError(
        'invalid_message',
        '@velajs/mail: message has a template but no render seam is configured',
      );
    }
    let rendered: unknown;
    try {
      rendered = await opts.render(msg.template);
    } catch (cause) {
      throw new MailError('render_failed', '@velajs/mail: template rendering failed', { cause });
    }
    if (typeof rendered !== 'object' || rendered === null || Array.isArray(rendered)) {
      throw new MailError('render_failed', '@velajs/mail: template renderer returned invalid data');
    }
    const renderedRecord = rendered as Record<string, unknown>;
    if (renderedRecord.html !== undefined && typeof renderedRecord.html !== 'string') {
      throw new MailError('render_failed', '@velajs/mail: template renderer returned invalid html');
    }
    if (renderedRecord.text !== undefined && typeof renderedRecord.text !== 'string') {
      throw new MailError('render_failed', '@velajs/mail: template renderer returned invalid text');
    }
    html = html ?? renderedRecord.html;
    text = text ?? renderedRecord.text;
  }

  if (html !== undefined && typeof html !== 'string') {
    throw new MailError('invalid_message', '@velajs/mail: rendered html body is not a string');
  }
  if (text !== undefined && typeof text !== 'string') {
    throw new MailError('invalid_message', '@velajs/mail: rendered text body is not a string');
  }

  // 2. VALIDATE
  assertSafeSubject(msg.subject);
  const headers: Record<string, string> = {};
  if (msg.headers) {
    if (typeof msg.headers !== 'object' || Array.isArray(msg.headers)) {
      throw new MailError('invalid_header', '@velajs/mail: custom headers must be an object');
    }
    if (Object.keys(msg.headers).length > limits.maxHeaders) {
      throw new MailError(
        'invalid_header',
        `@velajs/mail: message exceeds ${limits.maxHeaders} custom headers`,
      );
    }
    for (const [name, value] of Object.entries(msg.headers)) {
      assertAllowedCustomHeaderName(name);
      if (typeof value !== 'string') {
        throw new MailError('invalid_header', `@velajs/mail: header "${name}" must be a string`);
      }
      assertSafeHeaderValue(name, value);
      headers[name] = value;
    }
  }

  const requestedRecipients = [msg.to, msg.cc, msg.bcc].reduce(
    (total, value) => total + (value === undefined ? 0 : Array.isArray(value) ? value.length : 1),
    0,
  );
  if (requestedRecipients > limits.maxRecipients) {
    throw new MailError(
      'invalid_message',
      `@velajs/mail: message exceeds ${limits.maxRecipients} recipients`,
    );
  }

  const from = parseAddress(msg.from ?? opts.from);
  const to = parseAddressList(msg.to);
  const cc = msg.cc === undefined ? [] : parseAddressList(msg.cc);
  const bcc = msg.bcc === undefined ? [] : parseAddressList(msg.bcc);
  const replyTo = msg.replyTo === undefined ? undefined : parseAddress(msg.replyTo);

  if (to.length === 0) {
    throw new MailError('invalid_message', '@velajs/mail: message has no recipients');
  }
  if (html === undefined && text === undefined) {
    throw new MailError('invalid_message', '@velajs/mail: message has no html or text body');
  }

  // 3. BUILD
  const built: BuiltMessage = {
    from,
    to,
    cc,
    bcc,
    subject: msg.subject,
    headers,
    envelope: { from: from.email, to: uniqueEmails([...to, ...cc, ...bcc]) },
  };
  if (replyTo !== undefined) built.replyTo = replyTo;
  if (html !== undefined) built.html = html;
  if (text !== undefined) built.text = text;
  enforceBuiltMessageLimits(built, limits);
  return built;
}

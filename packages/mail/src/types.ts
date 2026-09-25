/**
 * Outbound message shapes. `MailMessage` is the caller-facing input; a
 * `BuiltMessage` is the fully validated, normalized, JSON-serializable value
 * that is the ONLY thing any {@link MailTransport} ever receives.
 */

/** A normalized, post-guard address. */
export interface Address {
  email: string;
  name?: string;
}

/** Accepted address input: a bare address, a bracketed `Name <a@b.c>`, or an object. */
export type AddressInput = string | Address;

/** Opaque to the core — only the configured {@link RenderSeam} interprets it. */
export interface RenderInput {
  [key: string]: unknown;
}

/** Prerendered bodies produced by a {@link RenderSeam}. */
export interface RenderedBody {
  html?: string;
  text?: string;
}

/** Pluggable template renderer. Kept neutral: the core never renders HTML/TSX itself. */
export type RenderSeam = (input: RenderInput) => Promise<RenderedBody> | RenderedBody;

/**
 * Caller-facing message. Supply prerendered `html`/`text`, or a `template`
 * resolved by the configured {@link RenderSeam}; explicit `html`/`text` win over
 * a rendered result.
 */
export interface MailMessage {
  /** Falls back to the mailer's default `from`. */
  from?: AddressInput;
  to: AddressInput | AddressInput[];
  cc?: AddressInput | AddressInput[];
  bcc?: AddressInput | AddressInput[];
  replyTo?: AddressInput;
  subject: string;
  html?: string;
  text?: string;
  /** Requires a configured {@link RenderSeam}; explicit `html`/`text` win. */
  template?: RenderInput;
  /** Extra custom headers — name and value are both guarded. */
  headers?: Record<string, string>;
}

/**
 * Fully validated + normalized. JSON-serializable so it rides a queue intact.
 * Every string here has already cleared the injection guards.
 */
export interface BuiltMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: Address;
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  /** Envelope for raw/SMTP-style transports: MAIL FROM + one RCPT TO per recipient. */
  envelope: { from: string; to: string[] };
}

/** Provider submission metadata; not proof of recipient delivery or exactly-once sending. */
export interface DeliveryResult {
  id?: string;
  provider?: string;
}

/**
 * The one-method structural transport seam. A transport receives ONLY a
 * {@link BuiltMessage} — every guard has already run above this boundary.
 */
export interface MailTransport {
  deliver(message: BuiltMessage): Promise<DeliveryResult>;
}

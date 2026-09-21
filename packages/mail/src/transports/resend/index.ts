import { MailError } from '../../mail.error';
import type { Address, BuiltMessage, DeliveryResult, MailTransport } from '../../types';

export interface ResendTransportOptions {
  apiKey: string;
  /** Override the API endpoint (default `https://api.resend.com/emails`). */
  baseUrl?: string;
  /** Inject a `fetch` implementation (tests, custom agents). Default global `fetch`. */
  fetch?: typeof fetch;
}

/** `Name <addr>` or a bare `addr` — the string form Resend's JSON API expects. */
function formatAddress(a: Address): string {
  return a.name !== undefined && a.name.length > 0 ? `${a.name} <${a.email}>` : a.email;
}

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

function toPayload(built: BuiltMessage): ResendPayload {
  const payload: ResendPayload = {
    from: formatAddress(built.from),
    to: built.to.map(formatAddress),
    subject: built.subject,
  };
  if (built.cc.length > 0) payload.cc = built.cc.map(formatAddress);
  if (built.bcc.length > 0) payload.bcc = built.bcc.map(formatAddress);
  if (built.replyTo !== undefined) payload.reply_to = formatAddress(built.replyTo);
  if (built.html !== undefined) payload.html = built.html;
  if (built.text !== undefined) payload.text = built.text;
  if (Object.keys(built.headers).length > 0) payload.headers = built.headers;
  return payload;
}

/**
 * A structural, SDK-free Resend HTTP transport. It only assembles a JSON body
 * and POSTs it with `fetch`; the message it receives has already cleared every
 * guard, so nothing here can inject a header.
 *
 * On a non-2xx response it throws a fixed, client-safe {@link MailError}
 * (`provider_error`, `internal: true`). The response body is read only into the
 * error's `cause` for server-side logging — it NEVER enters the thrown
 * `.message`, so provider detail is not leaked to a client.
 */
export function resendTransport(options: ResendTransportOptions): MailTransport {
  const endpoint = options.baseUrl ?? 'https://api.resend.com/emails';
  const doFetch = options.fetch ?? fetch;

  return {
    async deliver(built: BuiltMessage): Promise<DeliveryResult> {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(toPayload(built)),
        });
      } catch (cause) {
        // Network/transport failure — never surface the raw cause message.
        throw new MailError('provider_error', '@velajs/mail: email delivery failed', {
          internal: true,
          cause,
        });
      }

      if (!response.ok) {
        // Drain the body into `cause` for server-side logs ONLY.
        const cause = await response.text().catch(() => undefined);
        throw new MailError('provider_error', '@velajs/mail: email delivery failed', {
          internal: true,
          status: response.status,
          cause,
        });
      }

      const json: unknown = await response.json().catch(() => ({}));
      const id =
        typeof json === 'object' &&
        json !== null &&
        typeof (json as { id?: unknown }).id === 'string'
          ? (json as { id: string }).id
          : undefined;
      return id === undefined ? { provider: 'resend' } : { id, provider: 'resend' };
    },
  };
}

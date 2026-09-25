import { describe, expect, it } from 'vitest';
import { readInboundEmail, type InboundEmailMessage } from '../index';
import { MailError } from '../mail.error';

const RAW =
  'From: Ada <ada@example.net>\r\nTo: support@example.com\r\nSubject: Printer\r\n\r\nIt jammed.';

/** A platform inbound message whose raw stream arrives in `chunks`. */
function message(
  chunks: readonly string[],
  envelope = { from: 'bounce@example.net', to: 'support@example.com' },
  rawSize?: number,
): InboundEmailMessage & { readonly cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  let next = 0;
  return {
    ...envelope,
    rawSize: rawSize ?? chunks.reduce((total, chunk) => total + encoder.encode(chunk).length, 0),
    // One chunk per pull, as a platform stream delivers them.
    raw: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[next++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    cancelled: () => cancelled,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

describe('readInboundEmail', () => {
  it('reads an Email Workers message into an InboundEmail with its SMTP envelope', async () => {
    const email = await readInboundEmail(message([RAW.slice(0, 20), RAW.slice(20)]));
    expect(email.from).toBe('Ada <ada@example.net>');
    expect(email.to).toEqual(['support@example.com']);
    expect(email.subject).toBe('Printer');
    // The envelope routes the message; headers are only what the sender claims.
    expect(email.envelope).toEqual({ from: 'bounce@example.net', to: 'support@example.com' });
    expect(email.rawText()).toBe(RAW);
    // Nothing verified the sender: the default gate rejects it.
    expect(email.authentication).toEqual({ dkim: null, spf: null, dmarc: null });
    expect(email.authenticationSource).toBe('none');
  });

  it('passes verified authentication through', async () => {
    const email = await readInboundEmail(message([RAW]), {
      verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
    });
    expect(email.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
    expect(email.authenticationSource).toBe('adapter');
  });

  it('refuses a message larger than the limit before and while reading it', async () => {
    const declared = message([RAW], undefined, 10_000);
    const tooLarge = await rejection(
      readInboundEmail(declared, { limits: { maxMessageBytes: 1_000 } }),
    );
    expect(tooLarge).toBeInstanceOf(MailError);
    expect(tooLarge).toMatchObject({ code: 'inbound_malformed' });
    expect(declared.cancelled()).toBe(true);

    // A size the platform understated is still enforced on the stream itself.
    const streamed = message(['x'.repeat(600), 'y'.repeat(600)], undefined, 10);
    const overrun = await rejection(
      readInboundEmail(streamed, { limits: { maxMessageBytes: 1_000 } }),
    );
    expect(overrun).toMatchObject({ code: 'inbound_malformed' });
    expect(streamed.cancelled()).toBe(true);
  });

  it('rejects an envelope with line breaks', async () => {
    const error = await rejection(
      readInboundEmail(message([RAW], { from: 'a@example.net\r\nBcc: x', to: 'b@example.com' })),
    );
    expect(error).toBeInstanceOf(MailError);
  });
});

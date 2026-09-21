import { describe, expect, it } from 'vitest';
import { parseInboundEmail } from '../inbound/parse';
import { MailError } from '../mail.error';

/** Build a raw message with CRLF endings from header lines + a body. */
function raw(headerLines: string[], body = 'Hello body'): string {
  return `${headerLines.join('\r\n')}\r\n\r\n${body}`;
}

describe('parseInboundEmail — header parse', () => {
  it('splits the header block and extracts core fields', () => {
    const email = parseInboundEmail(
      raw([
        'From: Alice <alice@example.com>',
        'To: bob@example.com, carol@example.com',
        'Cc: dave@example.com',
        'Subject: Meeting',
        'Message-ID: <abc@example.com>',
        'In-Reply-To: <prev@example.com>',
        'References: <r1@example.com>',
      ]),
      { trustedAuthservIds: ['mx.example.com'] },
    );
    expect(email.from).toBe('Alice <alice@example.com>');
    expect(email.to).toEqual(['bob@example.com', 'carol@example.com', 'dave@example.com']);
    expect(email.subject).toBe('Meeting');
    expect(email.messageId).toBe('<abc@example.com>');
    expect(email.inReplyTo).toBe('<prev@example.com>');
    expect(email.references).toBe('<r1@example.com>');
  });

  it('unfolds continuation lines (leading SP/HTAB)', () => {
    const email = parseInboundEmail(
      raw(['Subject: first part', ' second part', '\tthird part', 'To: a@b.com']),
    );
    expect(email.subject).toBe('first part second part\tthird part');
    expect(email.headers.to).toBe('a@b.com');
  });

  it('lowercases header keys and keeps the last value on duplicates', () => {
    const email = parseInboundEmail(raw(['X-Tag: one', 'x-tag: two', 'To: a@b.com']));
    expect(email.headers['x-tag']).toBe('two');
  });

  it('exposes raw()/rawText() round-tripping the bytes', () => {
    const source = raw(['Subject: Hi', 'To: a@b.com'], 'the body');
    const email = parseInboundEmail(source);
    expect(email.rawText()).toBe(source);
    expect(new TextDecoder().decode(email.raw())).toBe(source);
  });

  it('accepts Uint8Array and ArrayBuffer inputs', () => {
    const source = raw(['Subject: Hi', 'To: a@b.com']);
    const bytes = new TextEncoder().encode(source);
    expect(parseInboundEmail(bytes).subject).toBe('Hi');
    expect(parseInboundEmail(bytes.buffer).subject).toBe('Hi');
  });

  it('throws inbound_malformed when there is no header/body separator', () => {
    let code: string | undefined;
    try {
      parseInboundEmail('Subject: Hi\r\nTo: a@b.com');
    } catch (err) {
      if (err instanceof MailError) code = err.code;
    }
    expect(code).toBe('inbound_malformed');
  });

  it('rejects a lone CR that survives unfolding (would split a header downstream)', () => {
    // A physical line carrying a lone CR (not part of CRLF) inside its value.
    const source = 'Subject: evil\rinjected\r\nTo: a@b.com\r\n\r\nbody';
    let code: string | undefined;
    try {
      parseInboundEmail(source);
    } catch (err) {
      if (err instanceof MailError) code = err.code;
    }
    expect(code).toBe('invalid_header');
  });
});

describe('parseInboundEmail — authentication verdicts', () => {
  it('parses dkim/spf/dmarc from Authentication-Results', () => {
    const email = parseInboundEmail(
      raw([
        'Authentication-Results: mx.example.com; dkim=pass; spf=pass; dmarc=pass',
        'To: a@b.com',
      ]),
      { trustedAuthservIds: ['mx.example.com'] },
    );
    expect(email.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  });

  it('is case-insensitive and lowercases verdicts', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: x; DKIM=Pass; SPF=Fail; DMARC=None', 'To: a@b.com']),
      { trustedAuthservIds: ['x'] },
    );
    expect(email.authentication).toEqual({ dkim: 'pass', spf: 'fail', dmarc: 'none' });
  });

  it('does not parse forged verdicts from quoted reason text or comments', () => {
    const email = parseInboundEmail(
      raw([
        'Authentication-Results: x; spf=fail reason="dmarc=pass"; dmarc=fail (dkim=pass)',
        'To: a@b.com',
      ]),
      { trustedAuthservIds: ['x'] },
    );
    expect(email.authentication).toEqual({ dkim: null, spf: 'fail', dmarc: 'fail' });
  });

  it('leaves mechanisms absent from the header as null', () => {
    const email = parseInboundEmail(raw(['Authentication-Results: x; spf=pass', 'To: a@b.com']), {
      trustedAuthservIds: ['x'],
    });
    expect(email.authentication).toEqual({ dkim: null, spf: 'pass', dmarc: null });
  });

  it('returns all null when there is no Authentication-Results header', () => {
    const email = parseInboundEmail(raw(['Subject: Hi', 'To: a@b.com']));
    expect(email.authentication).toEqual({ dkim: null, spf: null, dmarc: null });
  });

  it('reads verdicts from the TOPMOST Authentication-Results (document order)', () => {
    // A genuine top verdict (stamped by the receiving MTA) that PASSES, plus an
    // attacker-injected lower header that claims a pass but sits below. Since
    // last-wins would let the lower one win the `headers` view, this proves the
    // verdicts come from the topmost occurrence instead.
    const email = parseInboundEmail(
      raw([
        'Authentication-Results: mx.example.com; dkim=fail; spf=fail; dmarc=fail',
        'Authentication-Results: attacker.example; dkim=pass; spf=pass; dmarc=pass',
        'To: a@b.com',
      ]),
      { trustedAuthservIds: ['mx.example.com'] },
    );
    expect(email.authentication).toEqual({ dkim: 'fail', spf: 'fail', dmarc: 'fail' });
  });

  it('treats an unknown verdict token as a hard failure (permerror)', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: x; dmarc=bogus', 'To: a@b.com']),
      { trustedAuthservIds: ['x'] },
    );
    expect(email.authentication.dmarc).toBe('permerror');
  });

  it('does not trust a raw Authentication-Results header by default', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: attacker.example; dmarc=pass', 'To: a@b.com']),
    );
    expect(email.authentication).toEqual({ dkim: null, spf: null, dmarc: null });
    expect(email.authenticationSource).toBe('none');
    expect(Object.hasOwn(email.headers, 'authentication-results')).toBe(false);
  });

  it('quarantines trusted Authentication-Results from public headers', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: mx.example; dmarc=pass', 'To: a@b.com']),
      { trustedAuthservIds: ['mx.example'] },
    );
    expect(email.authentication.dmarc).toBe('pass');
    expect(Object.hasOwn(email.headers, 'authentication-results')).toBe(false);
  });

  it('requires an exact configured authserv-id (no suffix spoofing)', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: mx.example.com.attacker.test; dmarc=pass', 'To: a@b.com']),
      { trustedAuthservIds: ['mx.example.com'] },
    );
    expect(email.authentication.dmarc).toBeNull();
  });

  it('accepts a trusted adapter verdict without consulting message headers', () => {
    const email = parseInboundEmail(
      raw(['Authentication-Results: attacker.example; dmarc=fail', 'To: a@b.com']),
      {
        verifiedAuthentication: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
      },
    );
    expect(email.authentication).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
    expect(email.authenticationSource).toBe('adapter');
  });

  it('caps message, header, header-count, and recipient resources', () => {
    expect(() =>
      parseInboundEmail(raw(['To: a@b.com'], '12345'), { limits: { maxMessageBytes: 8 } }),
    ).toThrowError(MailError);
    expect(() =>
      parseInboundEmail(raw(['X-A: 12345']), { limits: { maxHeaderBytes: 3 } }),
    ).toThrowError(MailError);
    expect(() =>
      parseInboundEmail(raw(['X-A: 1', 'X-B: 2']), { limits: { maxHeaders: 1 } }),
    ).toThrowError(MailError);
    expect(() =>
      parseInboundEmail(raw(['To: a@b.com,c@d.com']), { limits: { maxRecipients: 1 } }),
    ).toThrowError(MailError);
  });

  it('stores hostile header names in a null-prototype map', () => {
    const email = parseInboundEmail(raw(['__proto__: polluted', 'To: a@b.com']));
    expect(Object.getPrototypeOf(email.headers)).toBeNull();
    expect(Object.hasOwn(email.headers, '__proto__')).toBe(true);
    expect(email.headers.__proto__).toBe('polluted');
  });
});

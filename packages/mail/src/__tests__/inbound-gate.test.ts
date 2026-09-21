import { describe, expect, it } from 'vitest';
import { DEFAULT_INBOUND_GATE, evaluateInboundGate } from '../inbound/gate';
import { parseInboundEmail } from '../inbound/parse';
import type { InboundAuthentication, Verdict } from '../inbound/parse';

function auth(overrides: Partial<InboundAuthentication> = {}): InboundAuthentication {
  return { dkim: null, spf: null, dmarc: null, ...overrides };
}

function email() {
  return parseInboundEmail('From: a@b.com\r\nTo: c@d.com\r\n\r\nbody');
}

const NON_PASS: Verdict[] = [null, 'fail', 'none', 'neutral', 'softfail', 'temperror', 'permerror'];

describe('evaluateInboundGate — fail-closed', () => {
  it('the default gate requires dmarc === pass', () => {
    expect(DEFAULT_INBOUND_GATE).toEqual({ require: ['dmarc'] });
    expect(evaluateInboundGate(DEFAULT_INBOUND_GATE, auth({ dmarc: 'pass' }), email())).toEqual({
      ok: true,
      failed: [],
    });
  });

  it.each(NON_PASS)('the default gate rejects dmarc=%s', (verdict) => {
    const result = evaluateInboundGate(DEFAULT_INBOUND_GATE, auth({ dmarc: verdict }), email());
    expect(result.ok).toBe(false);
    expect(result.failed).toContain('dmarc');
  });

  it('rejects when Authentication-Results is missing entirely (all null)', () => {
    const result = evaluateInboundGate(DEFAULT_INBOUND_GATE, email().authentication, email());
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(['dmarc']);
  });

  it('AND-composes multiple required mechanisms', () => {
    const gate = { require: ['dkim', 'spf', 'dmarc'] as const };
    expect(
      evaluateInboundGate(
        { require: [...gate.require] },
        auth({ dkim: 'pass', spf: 'pass', dmarc: 'pass' }),
        email(),
      ).ok,
    ).toBe(true);
    const partial = evaluateInboundGate(
      { require: [...gate.require] },
      auth({ dkim: 'pass', spf: 'fail', dmarc: 'pass' }),
      email(),
    );
    expect(partial.ok).toBe(false);
    expect(partial.failed).toEqual(['spf']);
  });

  it('AND-composes a custom policy on top of require', () => {
    const gate = {
      require: ['dmarc'] as ('dkim' | 'spf' | 'dmarc')[],
      policy: (a: InboundAuthentication) => a.spf === 'pass',
    };
    // require passes but policy fails.
    const r1 = evaluateInboundGate(gate, auth({ dmarc: 'pass', spf: 'fail' }), email());
    expect(r1.ok).toBe(false);
    expect(r1.failed).toContain('policy');
    // both pass.
    const r2 = evaluateInboundGate(gate, auth({ dmarc: 'pass', spf: 'pass' }), email());
    expect(r2.ok).toBe(true);
  });

  it('reports every offending mechanism in failed[]', () => {
    const result = evaluateInboundGate(
      { require: ['dkim', 'spf', 'dmarc'] },
      auth({ dkim: 'pass', spf: 'fail', dmarc: 'none' }),
      email(),
    );
    expect(result.failed).toEqual(['spf', 'dmarc']);
  });
});

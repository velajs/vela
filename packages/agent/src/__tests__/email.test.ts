import { describe, expect, expectTypeOf, it } from 'vitest';

import { firstEmailRun } from '../index';
import type { AgentEmailMapper, AgentEmailRun, InboundEmail } from '../index';

interface AuthVerdicts {
  dkim: 'pass' | 'fail' | null;
  spf: 'pass' | 'fail' | null;
  dmarc: 'pass' | 'fail' | null;
}

const makeEmail = (authentication: AuthVerdicts, from = 'sender@example.com'): InboundEmail => ({
  from,
  to: ['agent@myapp.com'],
  subject: 'Please help',
  headers: {},
  authentication,
  authenticationSource: 'adapter',
  raw: () => new Uint8Array(),
  rawText: () => '',
});

/** A mapper that fails closed on DMARC and derives owner from a verified signal. */
const strictMapper: AgentEmailMapper = (email) => {
  if (email.authentication.dmarc !== 'pass') {
    return null;
  }

  return {
    input: email.subject ?? '(no subject)',
    threadKey: `email:${email.from}`,
    owner: 'verified-owner',
    tenantId: 'verified-tenant',
  };
};

describe('onEmail contract', () => {
  it('maps a DMARC-passing email to a run start', async () => {
    const run = await strictMapper(makeEmail({ dkim: 'pass', spf: 'pass', dmarc: 'pass' }));

    expect(run).not.toBeNull();
    expect(run?.threadKey).toBe('email:sender@example.com');
    expect(run?.input).toBe('Please help');
    expect(run?.owner).toBe('verified-owner');
    expect(run?.tenantId).toBe('verified-tenant');
  });

  it('drops an email that fails DMARC', async () => {
    const run = await strictMapper(makeEmail({ dkim: 'pass', spf: 'pass', dmarc: 'fail' }));

    expect(run).toBeNull();
  });

  it('firstEmailRun returns the first non-null run and skips mapper-less targets', async () => {
    const email = makeEmail({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
    const run = await firstEmailRun([{ agent: {} }, { agent: { onEmail: strictMapper } }], email);

    expect(run?.threadKey).toBe('email:sender@example.com');
  });

  it('firstEmailRun returns undefined when every mapper drops the email', async () => {
    const email = makeEmail({ dkim: 'pass', spf: 'pass', dmarc: 'fail' });
    const run = await firstEmailRun([{ agent: { onEmail: strictMapper } }], email);

    expect(run).toBeUndefined();
  });

  it('types AgentEmailMapper as InboundEmail -> AgentEmailRun | null | undefined | Promise<...>', () => {
    expectTypeOf<AgentEmailMapper>().parameter(0).toEqualTypeOf<InboundEmail>();
    expectTypeOf<Awaited<ReturnType<AgentEmailMapper>>>().toEqualTypeOf<
      AgentEmailRun | null | undefined
    >();
  });
});

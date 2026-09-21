import { describe, expect, expectTypeOf, it } from 'vitest';
import { OnInboundEmail } from '../inbound/decorator';
import type { InboundAuthentication, InboundEmail, Verdict } from '../inbound/parse';
import type { MailInboundGate } from '../inbound/gate';
import type {
  Address,
  AddressInput,
  BuiltMessage,
  DeliveryResult,
  MailMessage,
  MailTransport,
  RenderedBody,
  RenderSeam,
} from '../types';

// These tests dogfood the exported signatures. They must typecheck under
// `tsc -p tsconfig.test.json` with no `as any`/`as never`.

describe('exported type signatures', () => {
  it('MailMessage accepts each documented address input shape', () => {
    const bare: AddressInput = 'a@b.com';
    const bracketed: AddressInput = 'Name <a@b.com>';
    const object: AddressInput = { email: 'a@b.com', name: 'Name' };
    const msg: MailMessage = {
      from: bare,
      to: [bracketed, object],
      cc: 'c@d.com',
      subject: 'Hi',
      text: 'body',
      headers: { 'X-Tag': 'v' },
    };
    expectTypeOf(msg.to).toEqualTypeOf<AddressInput | AddressInput[]>();
    expect(Array.isArray(msg.to)).toBe(true);
  });

  it('a BuiltMessage is what every transport receives', () => {
    const built: BuiltMessage = {
      from: { email: 'a@b.com' },
      to: [{ email: 'c@d.com' }],
      cc: [],
      bcc: [],
      subject: 'Hi',
      headers: {},
      envelope: { from: 'a@b.com', to: ['c@d.com'] },
    };
    expectTypeOf(built.from).toEqualTypeOf<Address>();
    expect(built.envelope.to).toEqual(['c@d.com']);
  });

  it('MailTransport is a one-method structural seam satisfied without a cast', () => {
    const transport: MailTransport = {
      async deliver(message: BuiltMessage): Promise<DeliveryResult> {
        return { id: message.subject };
      },
    };
    expectTypeOf(transport.deliver).parameter(0).toEqualTypeOf<BuiltMessage>();
    expectTypeOf(transport.deliver).returns.resolves.toEqualTypeOf<DeliveryResult>();
  });

  it('RenderSeam may return sync or async RenderedBody', () => {
    const sync: RenderSeam = () => ({ html: '<b>x</b>' });
    const async: RenderSeam = async () => ({ text: 'x' });
    expectTypeOf(sync).returns.toEqualTypeOf<Promise<RenderedBody> | RenderedBody>();
    expectTypeOf(async).returns.toEqualTypeOf<Promise<RenderedBody> | RenderedBody>();
  });

  it('InboundEmail exposes the shape a future onEmail(email) consumes', () => {
    const consume = (email: InboundEmail): void => {
      expectTypeOf(email.from).toEqualTypeOf<string>();
      expectTypeOf(email.to).toEqualTypeOf<string[]>();
      expectTypeOf(email.authentication).toEqualTypeOf<InboundAuthentication>();
      expectTypeOf(email.raw()).toEqualTypeOf<Uint8Array>();
      expectTypeOf(email.rawText()).toEqualTypeOf<string>();
    };
    expectTypeOf(consume).parameter(0).toEqualTypeOf<InboundEmail>();
  });

  it('Verdict is the closed union of authentication outcomes', () => {
    const verdicts: Verdict[] = [
      'pass',
      'fail',
      'neutral',
      'softfail',
      'none',
      'temperror',
      'permerror',
      null,
    ];
    expect(verdicts).toHaveLength(8);
  });

  it('MailInboundGate composes required mechanisms and policy', () => {
    const gate: MailInboundGate = {
      require: ['dkim', 'spf', 'dmarc'],
      policy: (auth, email) => auth.dmarc === 'pass' && email.from.length > 0,
    };
    expectTypeOf(gate.require).toEqualTypeOf<Array<'dkim' | 'spf' | 'dmarc'> | undefined>();
  });

  it('OnInboundEmail is a MethodDecorator with a typed match predicate', () => {
    const decorator = OnInboundEmail({ match: (email) => email.to.includes('x@y.com') });
    expectTypeOf(decorator).toEqualTypeOf<MethodDecorator>();
    expect(typeof decorator).toBe('function');
  });
});

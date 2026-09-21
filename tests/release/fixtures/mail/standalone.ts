import { resendTransport } from '@velajs/mail/transports/resend';
import { createMailCatcher } from '@velajs/mail/transports/catcher';
import { assertSent, type CapturedMessage } from '@velajs/mail/testing';

const catcher = createMailCatcher();
const captured: CapturedMessage = assertSent(catcher, { to: 'a@example.com' });
resendTransport({ apiKey: 'fixture' }).deliver(captured);

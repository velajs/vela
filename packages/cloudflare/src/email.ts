import './vela-env';
// Email Workers: importing OnEmail gives the Worker (`app.worker`) its `email` handler.
export { OnEmail } from './email/on-email';
export type { OnEmailDecorator, OnEmailOptions } from './email/on-email';
export { UNCLAIMED_EMAIL_REASON } from './email/email-dispatch';
export type { EmailExecutionContext } from './email/email-dispatch';

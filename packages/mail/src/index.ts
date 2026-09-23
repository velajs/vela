// @velajs/mail — edge-neutral mail for Vela.
//
// The main entry couples to `@velajs/vela` for the module/service/entrypoint
// wiring. The pure transports and the dev catcher live behind vela-free
// subpaths (`./transports/resend`, `./transports/catcher`, `./testing`) so
// importing one never pulls the framework.

// Errors
export { MailError } from './mail.error';
export type { MailErrorCode, MailErrorOptions } from './mail.error';

// Message shapes + the transport seam
export type {
  Address,
  AddressInput,
  BuiltMessage,
  DeliveryResult,
  MailMessage,
  MailTransport,
  RenderedBody,
  RenderInput,
  RenderSeam,
} from './types';

// Guards + pipeline
export {
  assertAllowedCustomHeaderName,
  assertSafeHeaderName,
  assertSafeHeaderValue,
  assertSafeSubject,
  MAX_EMAIL_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SUBJECT_LENGTH,
  parseAddress,
  parseAddressList,
} from './address';
export { DEFAULT_MAIL_LIMITS, enforceBuiltMessageLimits, resolveMailLimits } from './limits';
export type { MailLimits } from './limits';
export { buildMessage } from './build';
export type { BuildOptions } from './build';
export { renderRawMessage } from './render-raw';
export { reparseBuiltWire } from './wire';

// Inbound
export { parseInboundEmail } from './inbound/parse';
export { DEFAULT_INBOUND_MAIL_LIMITS } from './inbound/parse';
export type {
  InboundAuthentication,
  InboundEmail,
  InboundMailLimits,
  ParseInboundEmailOptions,
  Verdict,
} from './inbound/parse';
export { DEFAULT_INBOUND_GATE, evaluateInboundGate } from './inbound/gate';
export type { GateMechanism, GateResult, MailInboundGate } from './inbound/gate';
export { OnInboundEmail } from './inbound/decorator';
export type { OnInboundEmailMeta } from './inbound/decorator';
export { dispatchInboundEmail } from './inbound/dispatch';
export type { InboundDispatchResult } from './inbound/dispatch';

// Vela wiring
export { MailModule } from './mail.module';
export type {
  MailModuleAsyncOptions,
  MailModuleFactoryOptions,
  MailModuleOptions,
  MailQueueOptions,
} from './mail.module';
export { MailService } from './mail.service';
export { createMailSendProcessor, MailSendProcessor } from './mail.processor';
export {
  MAIL_INBOUND_GATE,
  MAIL_INBOUND_METADATA,
  MAIL_OPTIONS,
  MAIL_QUEUE,
  MAIL_QUEUE_JOB,
  MAIL_TRANSPORT,
} from './mail.tokens';
export type { ResolvedMailOptions } from './mail.tokens';

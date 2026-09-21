import { MailError } from '../mail.error';
import type { InboundAuthentication, InboundEmail } from './parse';

/** The mechanisms a gate can require to have passed. */
export type GateMechanism = 'dkim' | 'spf' | 'dmarc';

export interface MailInboundGate {
  /** Each listed mechanism MUST equal `'pass'`. Defaults to `['dmarc']`. */
  require?: GateMechanism[];
  /** Additional policy; always AND-composed with the required mechanisms. */
  policy?: (auth: InboundAuthentication, email: InboundEmail) => boolean;
}

/** Fail-closed default: a message must have `dmarc === 'pass'`. */
export const DEFAULT_INBOUND_GATE: MailInboundGate = snapshotInboundGate({ require: ['dmarc'] });

/** Snapshot configuration so callers cannot relax an already registered gate. */
export function snapshotInboundGate(gate: MailInboundGate): MailInboundGate {
  const required = gate.require ?? ['dmarc'];
  if (
    !Array.isArray(required) ||
    required.length === 0 ||
    required.some((mechanism) => !['dkim', 'spf', 'dmarc'].includes(mechanism)) ||
    (gate.policy !== undefined && typeof gate.policy !== 'function')
  ) {
    throw new MailError(
      'inbound_rejected',
      '@velajs/mail: gate requires at least one valid authentication mechanism',
    );
  }
  const snapshot: MailInboundGate = { require: [...required] };
  if (gate.policy !== undefined) snapshot.policy = gate.policy;
  Object.freeze(snapshot.require);
  return Object.freeze(snapshot);
}

export interface GateResult {
  ok: boolean;
  /** Mechanisms (and `'policy'`) that did not pass. */
  failed: string[];
}

/**
 * Evaluate an inbound gate, FAIL-CLOSED.
 *
 * Every required mechanism (default `['dmarc']`) must strictly `=== 'pass'`; any other value —
 * `null` (mechanism not reported / header missing), `fail`, `none`, `neutral`,
 * `softfail`, `temperror`, `permerror` — fails and is recorded. A `policy`, when
 * present, is AND-composed on top. Missing verdicts therefore reject by
 * construction.
 */
export function evaluateInboundGate(
  gate: MailInboundGate,
  auth: InboundAuthentication,
  email: InboundEmail,
): GateResult {
  const required = snapshotInboundGate(gate).require!;
  const failed: string[] = [];
  for (const mechanism of required) {
    if (auth[mechanism] !== 'pass') failed.push(mechanism);
  }

  let ok = failed.length === 0;
  if (gate.policy !== undefined && gate.policy(auth, email) !== true) {
    ok = false;
    failed.push('policy');
  }

  return { ok, failed };
}

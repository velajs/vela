/**
 * The inbound-email → run-start contract. `@velajs/mail`'s `InboundEmail` is
 * imported TYPE-ONLY, so it is erased at build and `@velajs/mail` is never a
 * runtime dependency (it is an optional type peer).
 *
 * GATE-TRUST NOTE: on Cloudflare, Email Routing authenticates only the recipient
 * domain. `email.from`, the subject, and the body are all SPOOFABLE, and an agent
 * run dispatches with privilege. A mapper MUST gate on `email.authentication`
 * (DKIM/SPF/DMARC verdicts, fail closed) and derive owner/tenant selectors from a
 * verified signal — never blindly from `email.from`. The agent's required
 * `resolveRunIdentity` must still validate them and derive the canonical scope.
 * Return `null`/`undefined` to drop the message.
 * The worker `email()` handler wiring itself lives in `@velajs/cloudflare` (a
 * documented follow-up), not here.
 */
import type { InboundEmail } from '@velajs/mail';
import { parseAgentRunParams } from './validation';

import type { AgentDefinition, AgentEmailRun } from './types';

/** Re-export the type-only inbound-email shape from the canonical `@velajs/mail` package. */
export type { InboundEmail };

/**
 * Walk `targets` in order and return the first non-null run a mapper produces. A
 * pure helper — it dispatches nothing (starting the run is the app/CF layer's job,
 * application-owned). Targets without an `onEmail` mapper are skipped.
 */
export const firstEmailRun = async (
  targets: ReadonlyArray<{ agent: Pick<AgentDefinition, 'onEmail'> }>,
  email: InboundEmail,
): Promise<AgentEmailRun | undefined> => {
  for (const target of targets) {
    const mapper = target.agent.onEmail;

    if (mapper === undefined) {
      continue;
    }

    const run = await mapper(email);

    if (run !== null && run !== undefined) {
      return parseAgentRunParams(run);
    }
  }

  return undefined;
};

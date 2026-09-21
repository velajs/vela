/**
 * Definition-time capability checking: a resource whose configuration needs
 * a capability the adapter doesn't declare must fail LOUDLY when the module
 * is defined — never a silent 404, a silent offset fallback, or a stub method
 * returning nothing (hono-crud `requireAdapter` parity).
 */

import {
  ADAPTER_CAPABILITIES,
  CAPABILITY_MEMBERS,
  type AdapterCapability,
  type RuntimeAdapter,
} from './contract';
import { ConfigurationException } from '../envelope/errors';
import { requireAtomicBatch } from './atomic';

/** One capability demand plus the config that raised it (for the error text). */
export interface CapabilityRequirement {
  capability: AdapterCapability;
  /** What in the resource config needs it, e.g. "pagination.cursor.enabled". */
  reason: string;
}

/**
 * Cross-checks a resource's capability requirements against an adapter:
 *
 * 1. every required capability is declared, and
 * 2. every declared capability that implies an optional member actually has
 *    that member (and vice versa) — a declared-but-missing method or a
 *    present-but-undeclared method is a mis-built adapter.
 *
 * Throws `ConfigurationException` listing every violation at once.
 */
export function assertAdapterSatisfies(
  resourceName: string,
  requirements: CapabilityRequirement[],
  adapter: RuntimeAdapter,
): void {
  const problems: string[] = [];
  if (adapter.capabilities.has('atomicBatch')) {
    try {
      requireAtomicBatch(adapter);
    } catch {
      problems.push('atomicBatch driver is incomplete');
    }
  }

  for (const { capability, reason } of requirements) {
    if (!adapter.capabilities.has(capability)) {
      problems.push(`requires '${capability}' (${reason}) but the adapter does not declare it`);
    }
  }

  for (const capability of ADAPTER_CAPABILITIES) {
    const member = CAPABILITY_MEMBERS[capability];
    if (member === undefined) continue;
    const declared = adapter.capabilities.has(capability);
    const present = adapter[member] !== undefined;
    if (declared && !present) {
      problems.push(`declares '${capability}' but is missing its '${String(member)}' member`);
    }
    if (!declared && present) {
      problems.push(
        `implements '${String(member)}' but does not declare '${capability}' — declare it or remove the member`,
      );
    }
  }

  if (adapter.nested !== undefined) {
    for (const method of ['inspectNestedTargets', 'createNested', 'applyNested'] as const) {
      if (typeof adapter.nested[method] !== 'function') {
        problems.push(`nested-write driver is missing its '${method}' method`);
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigurationException(
      `Resource '${resourceName}': adapter capability mismatch:\n- ${problems.join('\n- ')}`,
    );
  }
}

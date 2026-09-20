import type { InferStandardOutput, StandardIssue, StandardSchemaV1 } from './standard-schema';

/** How a resolver reacts when incoming claims fail their contract. */
export type OnInvalidMode = 'anonymous' | 'reject';

/** What validating a claim set against a contract produces. */
export type IdentityValidation = { ok: true } | { ok: false; error: string };

/**
 * A claim contract, produced by {@link defineIdentity}: it pairs the app's claim
 * **type** with a matching **runtime check** so both come from one place. It
 * exposes a discovery brand, the failure policy, and a `validate` that delegates
 * to the wrapped Standard Schema. `TClaims` is a compile-time-only parameter (it
 * has no runtime value) that {@link InferIdentity} reads the declared shape back
 * out of.
 */
export interface IdentityContract<TClaims extends { userId: string } = { userId: string }> {
  /** A brand that lets other code spot a contract structurally, with no import of this package. */
  readonly __velaIdentity: true;
  /** Type-only carrier for the declared claim shape; holds no runtime value. */
  readonly __claimType?: TClaims;
  /** Name of the claim that must be a non-empty string (defaults to `"userId"`). */
  readonly subjectClaim: string;
  /** What happens on a failed check: fall back to anonymous, or reject with a 401. */
  readonly onInvalid: OnInvalidMode;
  /**
   * Check a claim set against both the schema and the required string subject. A
   * synchronous schema (the usual case) returns a plain result; an asynchronous
   * one returns a promise — so callers should `await` the return in general.
   */
  validate: (claims: Record<string, unknown>) => IdentityValidation | Promise<IdentityValidation>;
}

/** Recover the declared claim type from an {@link IdentityContract}. */
export type InferIdentity<C> = C extends IdentityContract<infer TClaims> ? TClaims : never;

/** Options for {@link defineIdentity}. */
export interface DefineIdentitySpec<TClaims extends { userId: string }> {
  /**
   * A Standard Schema validator for the claim map. Its validated output must
   * extend `{ userId: string }` (or `{ [subjectClaim]: string }`) — an app that
   * forgets the required string subject fails to typecheck. zod 3.24+, valibot,
   * and arktype all satisfy this without a runtime dependency here.
   */
  claims: StandardSchemaV1<unknown, TClaims>;
  /** The required string subject claim. Defaults to `"userId"`. */
  subjectClaim?: string;
  /** Reject policy for contract-violating claims. Defaults to `"anonymous"`. */
  onInvalid?: OnInvalidMode;
}

/** Render Standard Schema issues into one short message (no claim values echoed). */
const summarizeIssues = (issues: ReadonlyArray<StandardIssue>): string => {
  const parts = issues.map((issue) => {
    const path = issue.path
      ?.map((segment) =>
        typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
      )
      .join('.');
    return path !== undefined && path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return parts.length > 0 ? parts.join('; ') : 'identity claims failed validation';
};

/**
 * State the app's identity claims in one place: a single declaration that fixes
 * both the compile-time type and the runtime check applied where untrusted claims
 * enter. The schema's output is required to include `{ userId: string }` (or the
 * chosen `subjectClaim`), which turns a forgotten subject into a type error. At
 * run time `validate` first defers to the schema and then independently confirms
 * the subject really is a non-empty string, so even a schema that lies its way
 * past the types still stays closed.
 *
 * `validate` is a gate and nothing more — it does not touch the claims — so the
 * resolver passes undeclared claims through as they arrived.
 *
 * @example
 * const identity = defineIdentity({ claims: z.object({ userId: z.string(), tenantId: z.string() }) });
 */
export const defineIdentity = <TClaims extends { userId: string }>(
  spec: DefineIdentitySpec<TClaims>,
): IdentityContract<TClaims> => {
  const subjectClaim = spec.subjectClaim ?? 'userId';
  const onInvalid: OnInvalidMode = spec.onInvalid ?? 'anonymous';
  const schema = spec.claims;

  const checkSubject = (claims: Record<string, unknown>): IdentityValidation => {
    const subject = claims[subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      return {
        ok: false,
        error: `identity claim "${subjectClaim}" must be a non-empty string`,
      };
    }
    return { ok: true };
  };

  const finish = (
    result: Awaited<ReturnType<StandardSchemaV1<unknown, TClaims>['~standard']['validate']>>,
    claims: Record<string, unknown>,
  ): IdentityValidation => {
    if (result.issues) return { ok: false, error: summarizeIssues(result.issues) };
    return checkSubject(claims);
  };

  return {
    __velaIdentity: true,
    subjectClaim,
    onInvalid,
    validate: (claims) => {
      const result = schema['~standard'].validate(claims);
      if (result instanceof Promise) return result.then((settled) => finish(settled, claims));
      return finish(result, claims);
    },
  };
};

export type { InferStandardOutput, StandardSchemaV1 };

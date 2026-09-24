import type { IdentityContract } from './identity-contract';
import type {
  AccessClaims,
  AccessKeySet,
  GroupRoleMapping,
  IssuerPreset,
  PrincipalType,
  RequestVerifyOptions,
  ResolvedIdentity,
  ResolveIdentity,
} from './types';
import { assertVerifyOptions, verifyRequest } from './verify';

/**
 * Raised by a resolver when a claim set is rejected by a contract configured with
 * `onInvalid: "reject"`. The `401` status lets a framework guard translate it
 * into an Unauthorized response. The message is deliberately value-free.
 */
export class IdentityRejectedError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
  }
}

/** Options for {@link createAccessResolver}. */
export interface CreateAccessResolverOptions {
  /** The wire/issuer preset. */
  preset: IssuerPreset;
  /** Required application audience tag(s). Fail-closed when empty. */
  aud: string | string[];
  /** Signed claim carrying tenant membership. Defaults to tenantId. */
  tenantClaim?: string;
  /** Add non-security identity fields derived from verified claims. */
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>;
  /** Explicitly map external identity-provider groups to application-local roles. */
  groupRoles?: GroupRoleMapping;
  /** Optional claim contract run over the verified claims before an identity is assembled. */
  identity?: IdentityContract;
  /** Observe present-but-invalid tokens. Never called for an absent token. */
  onError?: (error: unknown, request: Request) => void;
  /** Clock-skew tolerance in seconds. */
  clockToleranceSec?: number;
  /** Override the verification key source. Primarily for tests. */
  keySet?: AccessKeySet;
}

/** Coerce a value to a non-empty string, mapping `""`, non-strings, and nullish to `undefined`. */
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const SECURITY_FIELDS = new Set([
  '__proto__',
  'claims',
  'commonName',
  'constructor',
  'email',
  'exp',
  'expiresAtMs',
  'groups',
  'tenantId',
  'issuer',
  'principalType',
  'prototype',
  'roles',
  'subject',
  'userId',
]);

const normalizeGroups = (groups: unknown): string[] | undefined => {
  if (!Array.isArray(groups)) return undefined;
  const normalized = groups.filter(
    (group): group is string => typeof group === 'string' && group.length > 0,
  );
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
};

const assertGroupRoleMapping = (mapping: GroupRoleMapping | undefined): void => {
  if (mapping === undefined) return;
  for (const [group, configured] of Object.entries(mapping)) {
    if (group.length === 0) {
      throw new Error('@velajs/cloudflare-access: group role mapping keys must be non-empty');
    }
    const roles = Array.isArray(configured) ? configured : [configured];
    if (roles.length === 0 || roles.some((role) => typeof role !== 'string' || role.length === 0)) {
      throw new Error(
        `@velajs/cloudflare-access: group role mapping for "${group}" must contain non-empty roles`,
      );
    }
  }
};

/** Map external groups to local roles using own properties only. */
export const rolesFromGroups = (
  groups: readonly string[] | undefined,
  mapping: GroupRoleMapping | undefined,
): string[] => {
  if (mapping === undefined) return [];
  const roles = new Set<string>();
  for (const group of groups ?? []) {
    if (!Object.hasOwn(mapping, group)) continue;
    const configured = mapping[group];
    for (const role of Array.isArray(configured) ? configured : [configured]) {
      if (typeof role === 'string' && role.length > 0) roles.add(role);
    }
  }
  return [...roles];
};

/**
 * Pick the caller's durable id out of the verified claims. Interactive logins put
 * it in `sub`; when that is blank (service tokens have no `sub`) the code walks on
 * to `email` and finally `common_name`. If all three are empty there is no usable
 * id, so the caller is left anonymous rather than being assigned an empty-string
 * id that every id-less caller would end up sharing.
 */
const deriveSubject = (claims: AccessClaims, declaredSubjectClaim?: string): string | undefined =>
  nonEmptyString(claims.sub) ??
  (declaredSubjectClaim === undefined ? undefined : nonEmptyString(claims[declaredSubjectClaim])) ??
  nonEmptyString(claims.email) ??
  nonEmptyString(claims.common_name);

const derivePrincipalType = (claims: AccessClaims): PrincipalType =>
  nonEmptyString(claims.common_name) !== undefined &&
  nonEmptyString(claims.sub) === undefined &&
  nonEmptyString(claims.email) === undefined
    ? 'service'
    : 'user';

/**
 * Assemble the {@link ResolvedIdentity}. The whole claim set is retained under
 * `claims`; frequently-read non-authority fields are lifted when present. The
 * expiry is normalized once to milliseconds. `mapClaims` output is applied last
 * but is rejected if it attempts to replace any verified security field.
 */
const buildResolvedIdentity = (
  claims: AccessClaims,
  subject: string,
  groups: string[] | undefined,
  roles: string[],
  overrides: Record<string, unknown>,
  tenantClaim: string,
): ResolvedIdentity => {
  const issuer = nonEmptyString(claims.iss);
  const expiresAtMs = typeof claims.exp === 'number' ? claims.exp * 1000 : Number.NaN;
  if (issuer === undefined || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error('@velajs/cloudflare-access: verified identity claims are incomplete');
  }
  const resolved: ResolvedIdentity = {
    issuer,
    subject,
    principalType: derivePrincipalType(claims),
    expiresAtMs,
    claims,
  };
  if (claims[tenantClaim] !== undefined) {
    const tenantId = nonEmptyString(claims[tenantClaim]);
    if (tenantId === undefined)
      throw new Error('@velajs/cloudflare-access: invalid tenantId claim');
    resolved.tenantId = tenantId;
  }
  if (claims.email !== undefined) resolved.email = claims.email;
  if (claims.common_name !== undefined) resolved.commonName = claims.common_name;
  if (groups !== undefined) resolved.groups = groups;
  if (roles.length > 0) resolved.roles = roles;

  for (const [key, value] of Object.entries(overrides)) {
    if (SECURITY_FIELDS.has(key)) {
      throw new Error(
        `@velajs/cloudflare-access: mapClaims cannot replace verified security field "${key}"`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
};

/**
 * Convert verified claims into a {@link ResolvedIdentity}, or `null` when no
 * stable subject is available. Claim mapping may enrich the result but cannot
 * replace the verified subject, issuer, expiry, groups, claims, or local roles.
 */
const toResolvedIdentity = (
  claims: AccessClaims,
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>,
  groupRoles?: GroupRoleMapping,
  declaredSubjectClaim?: string,
  tenantClaim = 'tenantId',
): ResolvedIdentity | null => {
  const overrides = mapClaims ? mapClaims(structuredClone(claims)) : {};
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error('@velajs/cloudflare-access: mapClaims must return an object');
  }
  const subject = deriveSubject(claims, declaredSubjectClaim);
  if (subject === undefined) return null;
  const groups = normalizeGroups(claims.groups);
  return buildResolvedIdentity(
    claims,
    subject,
    groups,
    rolesFromGroups(groups, groupRoles),
    overrides,
    tenantClaim,
  );
};

/**
 * Produce a `resolveIdentity` function that turns a request into a verified
 * identity or anonymous `null`. Per call it verifies the token, optionally runs
 * the claim set through a {@link IdentityContract}, and shapes the result.
 *
 * The safe default runs through every branch: no token, an unverifiable token, or
 * (under `onInvalid: "anonymous"`) a contract miss all yield `null`. A contract
 * configured to `reject` instead throws {@link IdentityRejectedError}. Static
 * configuration is checked eagerly via {@link assertVerifyOptions}, so a
 * misconfigured build is loud at startup rather than silently anonymous later.
 */
export const createAccessResolver = (options: CreateAccessResolverOptions): ResolveIdentity => {
  assertVerifyOptions(options);
  assertGroupRoleMapping(options.groupRoles);
  if (options.tenantClaim !== undefined && !nonEmptyString(options.tenantClaim)) {
    throw new Error('@velajs/cloudflare-access: tenantClaim must be non-empty');
  }

  const verifyOptions: RequestVerifyOptions = {
    preset: options.preset,
    aud: options.aud,
    ...(options.clockToleranceSec === undefined
      ? {}
      : { clockToleranceSec: options.clockToleranceSec }),
    ...(options.keySet === undefined ? {} : { keySet: options.keySet }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };

  return async (request: Request): Promise<ResolvedIdentity | null> => {
    const claims = await verifyRequest(request, verifyOptions);
    if (claims === undefined) return null;
    // Hooks receive defensive clones. A claim validator or mapper is
    // application code and must not be able to mutate the verified authority
    // fields that this resolver subsequently trusts.
    const verifiedClaims = structuredClone(claims);

    if (options.identity !== undefined) {
      const result = await options.identity.validate(structuredClone(verifiedClaims));
      if (!result.ok) {
        if (options.identity.onInvalid === 'reject') {
          throw new IdentityRejectedError(
            `identity claims failed the declared contract: ${result.error}`,
          );
        }
        return null;
      }
    }

    return toResolvedIdentity(
      verifiedClaims,
      options.mapClaims,
      options.groupRoles,
      options.identity?.subjectClaim,
      options.tenantClaim,
    );
  };
};

/**
 * Chain resolvers into a single one that consults them left to right and returns
 * the first identity that comes back non-null; if every one declines, the result
 * is anonymous `null`. Resolution is strictly sequential on purpose — each step
 * gets a chance to claim the request before the next is asked.
 */
export const composeResolvers =
  (...resolvers: ResolveIdentity[]): ResolveIdentity =>
  async (request: Request, env?: unknown): Promise<ResolvedIdentity | null> => {
    for (const resolve of resolvers) {
      const identity = await resolve(request, env);
      if (identity) return identity;
    }
    return null;
  };

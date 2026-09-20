import { InjectionToken } from '@velajs/vela';
import type { IdentityContract } from '../identity-contract';
import type {
  AccessClaims,
  AccessKeySet,
  GroupRoleMapping,
  IssuerPreset,
  ResolveIdentity,
} from '../types';

/** How the guard treats an anonymous (unverified) caller. */
export type CloudflareAccessMode = 'required' | 'optional';

/** Options for {@link CloudflareAccessModule}. */
export interface CloudflareAccessModuleOptions {
  /** The wire/issuer preset (`cloudflareAccessIssuer(...)` or `genericOidcIssuer(...)`). */
  preset: IssuerPreset;
  /** Required application audience tag(s). Fail-closed when empty. */
  aud: string | string[];
  /** `required` (default) rejects anonymous callers; `optional` lets them pass through. */
  mode?: CloudflareAccessMode;
  /** Optional declared claim contract run over the verified claims before an identity is minted. */
  identity?: IdentityContract;
  /** Signed tenant membership claim; defaults to tenantId. */
  tenantClaim?: string;
  /** Remap verified claims into extra identity fields. */
  mapClaims?: (claims: AccessClaims) => Record<string, unknown>;
  /** Explicitly map external IdP groups to application-local roles. */
  groupRoles?: GroupRoleMapping;
  /** Clock-skew tolerance in seconds. */
  clockToleranceSec?: number;
  /** Override the verification key source. Primarily for tests. */
  keySet?: AccessKeySet;
  /** Observe present-but-invalid tokens. */
  onError?: (error: unknown, request: Request) => void;
}

/** The auto-provided options bag passed to {@link CloudflareAccessModule}. */
export const ACCESS_MODULE_OPTIONS = new InjectionToken<CloudflareAccessModuleOptions>(
  'vela.cloudflare-access.options',
);

/**
 * The built {@link ResolveIdentity} the module provides and exports. Exported so
 * an app can inject it and pass it to `composeResolvers(...)` alongside other
 * schemes.
 */
export const ACCESS_RESOLVER = new InjectionToken<ResolveIdentity>(
  'vela.cloudflare-access.resolver',
);

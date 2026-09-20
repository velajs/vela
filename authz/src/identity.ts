/** Stable principal kinds shared by HTTP, realtime, and background transports. */
export type PrincipalType = 'user' | 'service';

export interface Identity {
  /** Verified issuer namespace. Pair with `subject`; never key users by subject alone. */
  issuer?: string;
  /** Stable issuer-local subject. */
  subject?: string;
  /** Whether this principal represents an interactive user or a service identity. */
  principalType?: PrincipalType;
  /** @deprecated Compatibility alias for `subject`. */
  userId?: string;
  tenantId?: string;
  expiresAtMs?: number;
  roles?: readonly string[];
  claims?: Readonly<Record<string, unknown>>;
}

/** The zero-privilege identity. Fail-closed default when no session is present. */
export const anonymous: Identity = Object.freeze({
  roles: Object.freeze([]),
});

export interface PermissionResolver {
  grants(identity: Identity): Set<string> | Promise<Set<string>>;
}

export interface Identity {
  userId?: string;
  roles?: string[];
  claims?: Record<string, unknown>;
}

/** The zero-privilege identity. Fail-closed default when no session is present. */
export const anonymous: Identity = Object.freeze({ roles: Object.freeze([] as string[]) as string[] });

export interface PermissionResolver {
  grants(identity: Identity): Set<string> | Promise<Set<string>>;
}

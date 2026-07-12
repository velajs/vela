export type { Identity, PermissionResolver } from './identity';
export { anonymous } from './identity';

export type { RoleDef, PermissionDef } from './roles';
export { defineRole, definePermission } from './roles';

export { can } from './can';

export type { Authz, CreateAuthzOptions } from './authz';
export { createAuthz } from './authz';

export type { Policy } from './policy';
export { anyOf, allOf, hasPerm, mask } from './policy';

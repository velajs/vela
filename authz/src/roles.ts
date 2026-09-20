export interface RoleDef {
  readonly name: string;
  readonly permissions: readonly string[];
}
export interface PermissionDef {
  readonly name: string;
}

export const defineRole = (name: string, permissions: readonly string[]): RoleDef => ({
  name,
  permissions: [...permissions],
});

export const definePermission = (name: string): PermissionDef => ({ name });

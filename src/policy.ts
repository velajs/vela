import type { Authz } from './authz';
import type { Identity } from './identity';

export type Policy<C = { identity: Identity }, R = unknown> = (
  ctx: C,
  resource: R,
) => boolean | Promise<boolean>;

const runSafe = async (
  p: Policy<{ identity: Identity }, never>,
  ctx: unknown,
  resource: unknown,
): Promise<boolean> => {
  try {
    return (await (p as Policy<unknown, unknown>)(ctx, resource)) === true;
  } catch {
    return false; // a throwing policy never allows
  }
};

/** OR — read semantics. Any policy granting → allowed. Empty → denied. */
export const anyOf = (...policies: Policy<{ identity: Identity }, never>[]): Policy => async (ctx, resource) => {
  for (const p of policies) if (await runSafe(p, ctx, resource)) return true;
  return false;
};

/** AND — write semantics. All must allow. Empty → allowed (vacuous truth). */
export const allOf = (...policies: Policy<{ identity: Identity }, never>[]): Policy => async (ctx, resource) => {
  for (const p of policies) if (!(await runSafe(p, ctx, resource))) return false;
  return true;
};

/** Bridge a capability check into a Policy reading only ctx.identity. */
export const hasPerm = (authz: Authz, permission: string): Policy<{ identity: Identity }> =>
  (ctx) => authz.can(ctx.identity, permission);

/** Fail-closed field transform: a throwing mask redacts to null, never leaks. */
export const mask =
  <C, R, T>(fn: (ctx: C, record: R) => T): ((ctx: C, record: R) => T | null) =>
  (ctx, record) => {
    try {
      return fn(ctx, record);
    } catch {
      return null;
    }
  };

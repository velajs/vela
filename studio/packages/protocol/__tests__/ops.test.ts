import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  STUDIO_FEATURE_KEYS,
  STUDIO_OP_META,
  STUDIO_OPS,
  type DestructiveStudioOp,
  type StudioOp,
  type StudioOpMeta,
  type StudioRpcMap,
} from '../src/index';

/**
 * Widening reader: the `as const satisfies` op-meta keeps literal entry types
 * (so `destructive` narrows exactly), but every entry is still assignable to
 * `StudioOpMeta`. Reading through this typed accessor lets the runtime guards
 * touch optional fields without any cast (house rule: no `as never`/`as any`).
 */
const metaOf = (op: StudioOp): StudioOpMeta => STUDIO_OP_META[op];

describe('op catalog exhaustiveness (drift guard)', () => {
  it('STUDIO_OPS element union equals keyof StudioRpcMap (both directions)', () => {
    expectTypeOf<StudioOp>().toEqualTypeOf<(typeof STUDIO_OPS)[number]>();
  });

  it('STUDIO_OP_META is keyed by exactly the same ops as STUDIO_OPS', () => {
    const metaKeys = Object.keys(STUDIO_OP_META).toSorted();
    const opsList = [...STUDIO_OPS].toSorted();
    expect(opsList).toEqual(metaKeys);
  });

  it('STUDIO_OPS has no duplicates', () => {
    expect(new Set(STUDIO_OPS).size).toBe(STUDIO_OPS.length);
  });

  it('every op has a well-formed meta entry', () => {
    for (const op of STUDIO_OPS) {
      const meta = metaOf(op);
      expect(meta.mode === 'read' || meta.mode === 'write').toBe(true);
      expect(STUDIO_FEATURE_KEYS).toContain(meta.feature);
    }
  });
});

describe('feature coverage (drift guard)', () => {
  it('every STUDIO_FEATURE_KEYS member is referenced by at least one op meta', () => {
    const usedFeatures = new Set(STUDIO_OPS.map((op) => metaOf(op).feature));
    for (const key of STUDIO_FEATURE_KEYS) {
      expect(usedFeatures.has(key)).toBe(true);
    }
  });
});

describe('destructive ops require confirmToken', () => {
  const EXPECTED_DESTRUCTIVE = [
    'data.clearTable',
    'data.deleteRows',
    'timeTravel.armRestore',
    'timeTravel.prune',
    'timeTravel.undo',
    'transfer.import',
  ] as const;

  it('flags exactly the six destructive ops at runtime', () => {
    const destructive = STUDIO_OPS.filter((op) => metaOf(op).destructive === true).toSorted();
    expect(destructive).toEqual([...EXPECTED_DESTRUCTIVE].toSorted());
  });

  it("every destructive op's req type requires confirmToken (type-level)", () => {
    type ReqOf<K extends StudioOp> = StudioRpcMap[K]['req'];
    // A req with a required `confirmToken: string` yields `true`; an optional or
    // missing token yields `false`, which turns the mapped union into `boolean`
    // and fails the `toEqualTypeOf<true>()` assertion under `pnpm typecheck`.
    type HasRequiredConfirm<T> = T extends { confirmToken: string } ? true : false;
    type AllDestructiveHaveConfirm = {
      [K in DestructiveStudioOp]: HasRequiredConfirm<ReqOf<K>>;
    }[DestructiveStudioOp];
    expectTypeOf<AllDestructiveHaveConfirm>().toEqualTypeOf<true>();
  });

  it('rejects a destructive req literal missing confirmToken (type-level)', () => {
    const valid: StudioRpcMap['data.deleteRows']['req'] = {
      model: 'user',
      ids: ['1'],
      mode: 'soft',
      confirmToken: 'ct-abc',
    };
    expect(valid.confirmToken).toBe('ct-abc');

    // @ts-expect-error confirmToken is required on destructive op requests
    const invalid: StudioRpcMap['data.deleteRows']['req'] = {
      model: 'user',
      ids: ['1'],
      mode: 'hard',
    };
    expect(invalid.model).toBe('user');
  });

  it('non-destructive writeRow keeps confirmToken optional', () => {
    const req: StudioRpcMap['data.writeRow']['req'] = {
      model: 'user',
      patch: { name: 'a' },
    };
    expect(req.confirmToken).toBeUndefined();
  });
});

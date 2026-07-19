import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdminErrorBody, AdminResponseMeta, AdminRpcResponse } from '../src/index';

describe('AdminRpcResponse discriminates on `ok`', () => {
  const success: AdminRpcResponse<{ n: number }> = {
    ok: true,
    op: 'data.readRow',
    data: { n: 1 },
    meta: { ms: 3, op: 'data.readRow', mode: 'read' },
  };

  const failure: AdminRpcResponse<{ n: number }> = {
    ok: false,
    op: 'data.readRow',
    error: { code: 'STUDIO_DISABLED', title: 'Disabled', status: 403, message: 'off' },
    status: 403,
  };

  it('narrows to the ok branch (type-level + runtime)', () => {
    if (success.ok) {
      expectTypeOf(success.data).toEqualTypeOf<{ n: number }>();
      expectTypeOf(success.meta).toEqualTypeOf<AdminResponseMeta>();
      // @ts-expect-error the ok branch carries no `error`
      void success.error;
      expect(success.data.n).toBe(1);
      expect(success.meta.mode).toBe('read');
    } else {
      throw new Error('expected the ok branch');
    }
  });

  it('narrows to the error branch (type-level + runtime)', () => {
    if (!failure.ok) {
      expectTypeOf(failure.error).toEqualTypeOf<AdminErrorBody>();
      expectTypeOf(failure.status).toEqualTypeOf<number>();
      // @ts-expect-error the error branch carries no `data`
      void failure.data;
      expect(failure.status).toBe(403);
      expect(failure.error.code).toBe('STUDIO_DISABLED');
    } else {
      throw new Error('expected the error branch');
    }
  });
});

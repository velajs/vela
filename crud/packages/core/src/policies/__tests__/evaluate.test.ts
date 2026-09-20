import { describe, it, expect } from 'vitest';

import {
  canCreate,
  canPerformOperation,
  canRead,
  canWrite,
  filterReadable,
  maskFields,
  pushdownConditions,
} from '../evaluate';
import type { ModelPolicies, PolicyContext } from '../types';

interface Post {
  id: string;
  authorId: string;
  title: string;
  secret?: string;
}

function ctxFor(userId?: string): PolicyContext {
  return { userId, request: new Request('http://localhost/') };
}

const rows: Post[] = [
  { id: 'p1', authorId: 'alice', title: 'A1' },
  { id: 'p2', authorId: 'bob', title: 'B1' },
  { id: 'p3', authorId: 'alice', title: 'A2' },
];

describe('canPerformOperation', () => {
  it('evaluates the operation policy before executor work', async () => {
    await expect(canPerformOperation(ctxFor('alice'), 'read', {})).resolves.toBe(true);
    const policies: ModelPolicies<Post> = {
      operation: async (_ctx, operation) => operation === 'read',
    };
    await expect(canPerformOperation(ctxFor('alice'), 'read', policies)).resolves.toBe(true);
    await expect(canPerformOperation(ctxFor('alice'), 'aggregate', policies)).resolves.toBe(false);
  });
});

describe('canCreate', () => {
  it('defaults open and evaluates sync/async create predicates', async () => {
    await expect(canCreate(ctxFor('alice'), rows[0], {})).resolves.toBe(true);
    const policies: ModelPolicies<Post> = {
      create: async (ctx, post) => post.authorId === ctx.userId,
    };
    await expect(canCreate(ctxFor('alice'), rows[0], policies)).resolves.toBe(true);
    await expect(canCreate(ctxFor('bob'), rows[0], policies)).resolves.toBe(false);
  });
});

describe('canRead', () => {
  it('returns true when no read predicate is configured', async () => {
    await expect(canRead(ctxFor('alice'), rows[0], {})).resolves.toBe(true);
    await expect(canRead(ctxFor('alice'), rows[0], undefined)).resolves.toBe(true);
  });

  it('evaluates a synchronous read predicate', async () => {
    const policies: ModelPolicies<Post> = {
      read: (ctx, post) => post.authorId === ctx.userId,
    };
    await expect(canRead(ctxFor('alice'), rows[0], policies)).resolves.toBe(true);
    await expect(canRead(ctxFor('bob'), rows[0], policies)).resolves.toBe(false);
  });

  it('awaits an async read predicate and coerces to a strict boolean', async () => {
    const policies: ModelPolicies<Post> = {
      // Returns a truthy/falsy non-boolean to prove coercion.
      read: async (ctx, post) => (post.authorId === ctx.userId ? 1 : 0) as unknown as boolean,
    };
    await expect(canRead(ctxFor('alice'), rows[0], policies)).resolves.toBe(true);
    await expect(canRead(ctxFor('bob'), rows[0], policies)).resolves.toBe(false);
  });
});

describe('canWrite', () => {
  it('returns true when no write predicate is configured', async () => {
    await expect(canWrite(ctxFor('alice'), rows[0], {})).resolves.toBe(true);
  });

  it('evaluates sync and async write predicates', async () => {
    const sync: ModelPolicies<Post> = { write: (ctx, p) => p.authorId === ctx.userId };
    const async: ModelPolicies<Post> = {
      write: async (ctx, p) => p.authorId === ctx.userId,
    };
    await expect(canWrite(ctxFor('alice'), rows[0], sync)).resolves.toBe(true);
    await expect(canWrite(ctxFor('bob'), rows[0], sync)).resolves.toBe(false);
    await expect(canWrite(ctxFor('alice'), rows[0], async)).resolves.toBe(true);
    await expect(canWrite(ctxFor('bob'), rows[0], async)).resolves.toBe(false);
  });
});

describe('filterReadable', () => {
  it('returns the input untouched when no read predicate is configured', async () => {
    const out = await filterReadable(ctxFor('alice'), rows, {});
    expect(out).toBe(rows); // same reference — identity, no copy
  });

  it('silently drops rows the read predicate denies (list semantics)', async () => {
    const policies: ModelPolicies<Post> = {
      read: (ctx, post) => post.authorId === ctx.userId,
    };
    const out = await filterReadable(ctxFor('alice'), rows, policies);
    expect(out.map((r) => r.id)).toEqual(['p1', 'p3']);
  });

  it('supports async read predicates and preserves order', async () => {
    const policies: ModelPolicies<Post> = {
      read: async (_ctx, post) => post.id !== 'p2',
    };
    const out = await filterReadable(ctxFor('alice'), rows, policies);
    expect(out.map((r) => r.id)).toEqual(['p1', 'p3']);
  });

  it('propagates a throwing predicate instead of partially filtering', async () => {
    const policies: ModelPolicies<Post> = {
      read: (_ctx, post) => {
        if (post.id === 'p2') throw new Error('boom');
        return true;
      },
    };
    await expect(filterReadable(ctxFor('alice'), rows, policies)).rejects.toThrow('boom');
  });
});

describe('maskFields', () => {
  it('is identity when no fields mask is configured', () => {
    expect(maskFields(ctxFor('alice'), rows[0], {})).toBe(rows[0]);
  });

  it('overlays the returned partial onto the record', () => {
    const policies: ModelPolicies<Post> = {
      fields: () => ({ title: '***' }),
    };
    const masked = maskFields(
      ctxFor('alice'),
      { id: 'p1', authorId: 'a', title: 'secret' },
      policies,
    );
    expect(masked.title).toBe('***');
    expect(masked.id).toBe('p1');
  });

  it('can mask conditionally on the actor', () => {
    const policies: ModelPolicies<Post> = {
      fields: (ctx, post) => (post.authorId === ctx.userId ? {} : { secret: undefined }),
    };
    const own = maskFields(
      ctxFor('alice'),
      { id: 'p1', authorId: 'alice', title: 't', secret: 's' },
      policies,
    );
    const other = maskFields(
      ctxFor('bob'),
      { id: 'p1', authorId: 'alice', title: 't', secret: 's' },
      policies,
    );
    expect(own.secret).toBe('s');
    expect(other.secret).toBeUndefined();
  });
});

describe('pushdownConditions', () => {
  it('returns [] when no pushdown is configured', () => {
    expect(pushdownConditions(ctxFor('alice'), {})).toEqual([]);
    expect(pushdownConditions(ctxFor('alice'), undefined)).toEqual([]);
  });

  it('returns the readPushdown conditions for the actor', () => {
    const policies: ModelPolicies<Post> = {
      readPushdown: (ctx) => [{ field: 'authorId', operator: 'eq', value: ctx.userId ?? '' }],
    };
    expect(pushdownConditions(ctxFor('alice'), policies)).toEqual([
      { field: 'authorId', operator: 'eq', value: 'alice' },
    ]);
  });

  it('coerces a nullish readPushdown return to []', () => {
    const policies = {
      readPushdown: () => undefined,
    } as unknown as ModelPolicies<Post>;
    expect(pushdownConditions(ctxFor('alice'), policies)).toEqual([]);
  });
});

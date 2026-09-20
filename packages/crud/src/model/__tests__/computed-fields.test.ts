import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyComputedFields, applyComputedFieldsToArray } from '../computed-fields';
import { defineModel } from '../define-model';

const UserSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.enum(['active', 'inactive']),
});

type User = z.infer<typeof UserSchema>;

const model = defineModel({
  name: 'user',
  tableName: 'users',
  schema: UserSchema,
  computedFields: {
    fullName: { compute: (u: User) => `${u.firstName} ${u.lastName}` },
    isActive: { compute: (u: User) => u.status === 'active' },
    asyncGreeting: {
      compute: async (u: User) => {
        await new Promise((r) => setTimeout(r, 5));
        return `Hi ${u.firstName}`;
      },
    },
    boom: {
      compute: () => {
        throw new Error('nope');
      },
    },
  },
});

const alice: User = { id: '1', firstName: 'Alice', lastName: 'Ng', status: 'active' };
const bob: User = { id: '2', firstName: 'Bob', lastName: 'Lee', status: 'inactive' };

describe('applyComputedFields', () => {
  it('computes sync and async fields and preserves the original fields', async () => {
    const out = await applyComputedFields(model, alice);
    expect(out.fullName).toBe('Alice Ng');
    expect(out.isActive).toBe(true);
    expect(out.asyncGreeting).toBe('Hi Alice');
    expect(out.id).toBe('1');
    expect(out.firstName).toBe('Alice');
  });

  it('surfaces a failing compute as undefined rather than throwing', async () => {
    const out = await applyComputedFields(model, alice);
    expect('boom' in out).toBe(true);
    expect(out.boom).toBeUndefined();
  });

  it('does not mutate the input record', async () => {
    await applyComputedFields(model, alice);
    expect(alice).toEqual({ id: '1', firstName: 'Alice', lastName: 'Ng', status: 'active' });
    expect((alice as Record<string, unknown>).fullName).toBeUndefined();
  });

  it('returns the record unchanged (same reference) when the model has no computed fields', async () => {
    const bare = defineModel({ name: 'u', tableName: 'u', schema: UserSchema });
    const out = await applyComputedFields(bare, alice);
    expect(out).toBe(alice);
  });

  it('only evaluates the allow-listed computed fields when `only` is set', async () => {
    const out = await applyComputedFields(model, alice, { only: ['fullName'] });
    expect(out.fullName).toBe('Alice Ng');
    expect('isActive' in out).toBe(false);
    expect('boom' in out).toBe(false);
  });
});

describe('applyComputedFieldsToArray', () => {
  it('computes fields for every record independently', async () => {
    const out = await applyComputedFieldsToArray(model, [alice, bob]);
    expect(out[0].fullName).toBe('Alice Ng');
    expect(out[0].isActive).toBe(true);
    expect(out[1].fullName).toBe('Bob Lee');
    expect(out[1].isActive).toBe(false);
  });

  it('returns the array unchanged (same reference) when there are no computed fields', async () => {
    const bare = defineModel({ name: 'u', tableName: 'u', schema: UserSchema });
    const arr = [alice, bob];
    const out = await applyComputedFieldsToArray(bare, arr);
    expect(out).toBe(arr);
  });
});

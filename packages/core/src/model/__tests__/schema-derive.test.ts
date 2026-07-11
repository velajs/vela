import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '../define-model';
import { deriveCreateSchema, deriveUpdateSchema } from '../schema-derive';

const Schema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  tenantId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

function keys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

describe('deriveCreateSchema', () => {
  it('strips generated PKs, timestamp columns, and the tenant field', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, multiTenant: true });
    expect(keys(deriveCreateSchema(model))).toEqual(['email', 'name', 'role']);
  });

  it('keeps timestamp/tenant columns as writable when those features are off', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, timestamps: false });
    // tenant off (default) and timestamps off → only the PK is stripped.
    expect(keys(deriveCreateSchema(model))).toEqual(['createdAt', 'email', 'name', 'role', 'tenantId', 'updatedAt']);
  });

  it('produces a schema whose parse rejects the stripped id field via strict? (fields simply absent)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const create = deriveCreateSchema(model);
    expect('id' in create.shape).toBe(false);
    expect('createdAt' in create.shape).toBe(false);
  });

  it("keeps the PK required under id: 'client'", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'client' });
    const create = deriveCreateSchema(model);
    expect('id' in create.shape).toBe(true);
    // tenant off → tenantId stays a writable (required) field; only id differs.
    expect(create.safeParse({ name: 'a', email: 'e', role: 'r', tenantId: 't' }).success).toBe(false);
    expect(create.safeParse({ id: 'x', name: 'a', email: 'e', role: 'r', tenantId: 't' }).success).toBe(true);
  });
});

const PostSchema = z.object({
  id: z.string(),
  authorId: z.string().optional(),
  title: z.string().min(1),
});

const nestedModel = (nestedWrites: Record<string, boolean>, base: object = {}) =>
  defineModel({
    name: 'u',
    tableName: 'u',
    schema: Schema,
    ...base,
    relations: {
      posts: {
        type: 'hasMany' as const,
        target: 'posts',
        foreignKey: 'authorId',
        schema: PostSchema,
        nestedWrites,
      },
    },
  });

describe('nested-write schema merging', () => {
  it('merges the hasMany child shape into the create body (omitting id + FK)', () => {
    const create = deriveCreateSchema(nestedModel({ allowCreate: true }));
    expect('posts' in create.shape).toBe(true);
    const parsed = create.safeParse({
      name: 'a',
      email: 'e',
      role: 'r',
      tenantId: 't',
      posts: [{ title: 'P', id: 'evil', authorId: 'evil' }],
    });
    expect(parsed.success).toBe(true);
    const posts = (parsed.data as { posts: Array<Record<string, unknown>> }).posts;
    // Child shape omits exactly ['id', foreignKey]; unknown keys are stripped.
    expect(posts[0]).toEqual({ title: 'P' });
  });

  it('leaves the base schema untouched when no relation opts in (regression)', () => {
    const plain = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const withRelation = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      relations: {
        posts: { type: 'hasMany' as const, target: 'posts', foreignKey: 'authorId', schema: PostSchema },
      },
    });
    expect(keys(deriveCreateSchema(withRelation))).toEqual(keys(deriveCreateSchema(plain)));
    expect(keys(deriveUpdateSchema(withRelation))).toEqual(keys(deriveUpdateSchema(plain)));
  });

  it('merges only the flag-gated ops into the update envelope', () => {
    const update = deriveUpdateSchema(nestedModel({ allowCreate: true, allowDelete: true }));
    expect('posts' in update.shape).toBe(true);
    const ok = update.safeParse({ posts: { create: { title: 'N' }, delete: ['p1'] } });
    expect(ok.success).toBe(true);
    // Non-enabled ops are unknown keys — stripped, never dispatched.
    const stripped = update.safeParse({ posts: { update: [{ id: 'p1', title: 'X' }] } });
    expect(stripped.success).toBe(true);
    expect((stripped.data as { posts: Record<string, unknown> }).posts).toEqual({});
  });

  it('hasOne stays single-object on both create and update legs', () => {
    const model = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      relations: {
        profile: {
          type: 'hasOne' as const,
          target: 'profiles',
          foreignKey: 'userId',
          schema: PostSchema,
          nestedWrites: { allowCreate: true },
        },
      },
    });
    const create = deriveCreateSchema(model);
    expect(
      create.safeParse({ name: 'a', email: 'e', role: 'r', tenantId: 't', profile: [{ title: 'x' }] })
        .success,
    ).toBe(false);
    const update = deriveUpdateSchema(model);
    expect(update.safeParse({ profile: { create: [{ title: 'x' }] } }).success).toBe(false);
    expect(update.safeParse({ profile: { create: { title: 'x' } } }).success).toBe(true);
  });

  it('gates `set` behind BOTH allowConnect and allowDisconnect', () => {
    const both = deriveUpdateSchema(nestedModel({ allowConnect: true, allowDisconnect: true }));
    expect(both.safeParse({ posts: { set: null } }).success).toBe(true);
    // allowConnect alone must not grant the disconnect-all: `set` is an
    // unknown key there and gets stripped.
    const connectOnly = deriveUpdateSchema(nestedModel({ allowConnect: true }));
    const parsed = connectOnly.safeParse({ posts: { set: null } });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { posts: Record<string, unknown> }).posts).toEqual({});
  });

  it('strips the parent tenant column from child shapes (the engine stamps it)', () => {
    const TenantPost = PostSchema.extend({ tenantId: z.string().optional() });
    const model = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      multiTenant: true,
      relations: {
        posts: {
          type: 'hasMany' as const,
          target: 'posts',
          foreignKey: 'authorId',
          schema: TenantPost,
          nestedWrites: { allowCreate: true },
        },
      },
    });
    const parsed = deriveCreateSchema(model).safeParse({
      name: 'a',
      email: 'e',
      role: 'r',
      posts: [{ title: 'P', tenantId: 'evil' }],
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { posts: Array<Record<string, unknown>> }).posts[0]).toEqual({
      title: 'P',
    });
  });

  it("coexists with id: 'client' PK retention", () => {
    const create = deriveCreateSchema(nestedModel({ allowCreate: true }, { id: 'client' }));
    expect('id' in create.shape).toBe(true);
    expect('posts' in create.shape).toBe(true);
  });
});

describe('deriveUpdateSchema', () => {
  it('is the create base made fully partial (every field optional)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, multiTenant: true });
    const update = deriveUpdateSchema(model);
    expect(keys(update)).toEqual(['email', 'name', 'role']);
    // Partial: an empty object is valid.
    expect(update.safeParse({}).success).toBe(true);
    expect(update.safeParse({ name: 'x' }).success).toBe(true);
  });

  it("still excludes the PK under id: 'client' (identity is not patchable)", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'client' });
    expect('id' in deriveUpdateSchema(model).shape).toBe(false);
  });

  it('removes blocked fields in addition to the managed set', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { blocked: ['email'] });
    expect(keys(update)).toEqual(['name', 'role', 'tenantId']);
  });

  it('keeps only allowed fields when an allow-list is given', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { allowed: ['name', 'email'] });
    expect(keys(update)).toEqual(['email', 'name']);
  });

  it('applies blocked before allowed (a blocked field cannot be re-allowed)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { allowed: ['name', 'email'], blocked: ['email'] });
    expect(keys(update)).toEqual(['name']);
  });

  it('ignores allowed names that reference managed / absent fields (no throw)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    // 'id' is managed (already stripped) and 'ghost' is absent — both are no-ops.
    const update = deriveUpdateSchema(model, { allowed: ['name', 'id', 'ghost'] });
    expect(keys(update)).toEqual(['name']);
  });
});

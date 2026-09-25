// Ported from hono-crud tests/model-registry.test.ts, adapted for the native
// engine: RelationConfig `model` → `target`, entries carry a `name`, wired
// output is a normalized Model, and the meta/OpenAPI-only cases are dropped.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModels, defineModelsExtending } from '../model-registry';
import type { Model, RelationConfig } from '../model.types';

const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
const PostSchema = z.object({ id: z.string(), title: z.string(), authorId: z.string() });

/** Fresh circular User↔Post input map per test (guards the no-mutation contract). */
function circularInput() {
  return {
    users: {
      name: 'user',
      tableName: 'users',
      schema: UserSchema,
      primaryKeys: ['id'] as ['id'],
      relations: {
        posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' },
      },
    },
    posts: {
      name: 'post',
      tableName: 'posts',
      schema: PostSchema,
      primaryKeys: ['id'] as ['id'],
      relations: {
        author: { type: 'belongsTo', target: 'users', foreignKey: 'authorId' },
      },
    },
  } as const;
}

describe('defineModels', () => {
  it('wires a circular User↔Post graph, auto-populating relation schemas from siblings', () => {
    const db = defineModels(circularInput());

    expect(db.users.relations?.posts.schema).toBe(PostSchema);
    expect(db.posts.relations?.author.schema).toBe(UserSchema);
  });

  it('auto-populates relation response policies and serialization metadata', () => {
    const read = () => false;
    const db = defineModels({
      users: {
        name: 'user',
        tableName: 'users',
        schema: UserSchema,
        relations: { posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
      },
      posts: {
        name: 'post',
        tableName: 'posts',
        schema: PostSchema,
        policies: { read },
        serializationProfile: { exclude: ['title'] },
      },
    });

    expect(db.users.relations?.posts.response?.policies?.read).toBe(read);
    expect(db.users.relations?.posts.response?.serializationProfile).toEqual({
      exclude: ['title'],
    });
  });

  it('auto-populates relation.table from the sibling table object (undefined when the sibling has none)', () => {
    const usersTable = { _: { name: 'users', columns: {} } };
    const postsTable = { _: { name: 'posts', columns: {} } };
    const db = defineModels({
      users: {
        name: 'user',
        tableName: 'users',
        schema: UserSchema,
        primaryKeys: ['id'],
        table: usersTable,
        relations: { posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
      },
      posts: {
        name: 'post',
        tableName: 'posts',
        schema: PostSchema,
        primaryKeys: ['id'],
        table: postsTable,
        relations: { author: { type: 'belongsTo', target: 'users', foreignKey: 'authorId' } },
      },
    });

    expect(db.users.relations?.posts.table).toBe(postsTable);
    expect(db.posts.relations?.author.table).toBe(usersTable);

    const memory = defineModels(circularInput());
    expect(memory.users.relations?.posts.table).toBeUndefined();
  });

  it('rewrites relation.target from the registry key to the sibling tableName', () => {
    const db = defineModels({
      people: {
        name: 'person',
        tableName: 'persons',
        schema: UserSchema,
        primaryKeys: ['id'],
      },
      posts: {
        name: 'post',
        tableName: 'posts',
        schema: PostSchema,
        primaryKeys: ['id'],
        relations: { author: { type: 'belongsTo', target: 'people', foreignKey: 'authorId' } },
      },
    });

    expect(db.posts.relations?.author.target).toBe('persons');
    const same = defineModels(circularInput());
    expect(same.users.relations?.posts.target).toBe('posts');
  });

  it('keeps explicitly-authored schema/table by default (author wins)', () => {
    const ExplicitSchema = z.object({ id: z.string() });
    const explicitTable = { _: { name: 'posts_explicit', columns: {} } };
    const db = defineModels({
      users: {
        name: 'user',
        tableName: 'users',
        schema: UserSchema,
        primaryKeys: ['id'],
        relations: {
          posts: {
            type: 'hasMany',
            target: 'posts',
            foreignKey: 'authorId',
            schema: ExplicitSchema,
            table: explicitTable,
          },
        },
      },
      posts: { name: 'post', tableName: 'posts', schema: PostSchema, primaryKeys: ['id'] },
    });

    expect(db.users.relations?.posts.schema).toBe(ExplicitSchema);
    expect(db.users.relations?.posts.table).toBe(explicitTable);
  });

  it('overwriteExplicit: true replaces explicitly-authored schema with sibling values', () => {
    const ExplicitSchema = z.object({ id: z.string() });
    const db = defineModels(
      {
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: {
            posts: {
              type: 'hasMany',
              target: 'posts',
              foreignKey: 'authorId',
              schema: ExplicitSchema,
            },
          },
        },
        posts: { name: 'post', tableName: 'posts', schema: PostSchema, primaryKeys: ['id'] },
      },
      { overwriteExplicit: true },
    );

    expect(db.users.relations?.posts.schema).toBe(PostSchema);
  });

  it('autoPopulateSchema/autoPopulateTable: false disable population but keep the key rewrite', () => {
    const postsTable = { _: { name: 'posts', columns: {} } };
    const db = defineModels(
      {
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: { posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
        },
        posts: {
          name: 'post',
          tableName: 'posts',
          schema: PostSchema,
          primaryKeys: ['id'],
          table: postsTable,
        },
      },
      { autoPopulateSchema: false, autoPopulateTable: false },
    );

    expect(db.users.relations?.posts.schema).toBeUndefined();
    expect(db.users.relations?.posts.table).toBeUndefined();
    expect(db.users.relations?.posts.target).toBe('posts');
  });

  it('throws ONE aggregated plain Error listing every unknown internal target, with a suggestion', () => {
    let caught: unknown;
    try {
      defineModels({
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: {
            // @ts-expect-error - deliberately unknown sibling key (runtime path under test)
            posts: { type: 'hasMany', target: 'postz', foreignKey: 'authorId' },
            // @ts-expect-error - deliberately unknown sibling key (runtime path under test)
            avatar: { type: 'hasOne', target: 'nope', foreignKey: 'userId' },
          },
        },
        posts: { name: 'post', tableName: 'posts', schema: PostSchema, primaryKeys: ['id'] },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor).toBe(Error);
    const message = (caught as Error).message;
    expect(message).toContain("'postz'");
    expect(message).toContain("'nope'");
    expect(message.toLowerCase()).toContain("did you mean 'posts'");
  });

  it("onUnknownModel: 'ignore' leaves unknown targets unresolved without throwing", () => {
    const db = defineModels(
      {
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: {
            // @ts-expect-error - deliberately unknown sibling key (runtime path under test)
            posts: { type: 'hasMany', target: 'postz', foreignKey: 'authorId' },
          },
        },
      },
      { onUnknownModel: 'ignore' },
    );

    expect(db.users.relations?.posts.target).toBe('postz');
    expect(db.users.relations?.posts.schema).toBeUndefined();
  });

  it("onUnknownModel: 'ignore' never resolves Object.prototype members as siblings", () => {
    const db = defineModels(
      {
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: {
            // @ts-expect-error - not a sibling key; collides with an Object.prototype member
            weird: { type: 'belongsTo', target: 'constructor', foreignKey: 'x' },
          },
        },
      },
      { onUnknownModel: 'ignore' },
    );

    expect(db.users.relations?.weird.target).toBe('constructor');
    expect(db.users.relations?.weird.schema).toBeUndefined();
    expect(db.users.relations?.weird.table).toBeUndefined();
  });

  it('external: true skips sibling checking + auto-population and strips the marker', () => {
    const OrgSchema = z.object({ id: z.string(), name: z.string() });
    const db = defineModels({
      users: {
        name: 'user',
        tableName: 'users',
        schema: UserSchema,
        primaryKeys: ['id'],
        relations: {
          org: {
            type: 'belongsTo',
            target: 'organizations',
            foreignKey: 'orgId',
            external: true,
            schema: OrgSchema,
          },
        },
      },
    });

    const org = db.users.relations?.org as RelationConfig;
    expect(org.target).toBe('organizations');
    expect(org.schema).toBe(OrgSchema);
    expect('external' in org).toBe(false);
  });

  it('never mutates the author input map', () => {
    const input = circularInput();
    const inputPostsRelation = input.users.relations.posts;

    const db = defineModels(input);

    expect(inputPostsRelation).toEqual({
      type: 'hasMany',
      target: 'posts',
      foreignKey: 'authorId',
    });
    expect(db.users.relations?.posts).not.toBe(inputPostsRelation);
    expect(db.users).not.toBe(input.users);
  });

  it('freeze: true freezes the wired models and their relation configs', () => {
    const db = defineModels(circularInput(), { freeze: true });

    expect(Object.isFrozen(db.users)).toBe(true);
    expect(Object.isFrozen(db.users.relations)).toBe(true);
    expect(Object.isFrozen(db.users.relations?.posts)).toBe(true);
    expect(Object.isFrozen(db.users.relations?.posts.response)).toBe(true);
  });

  it('passes relation-less entries through with their config intact (and normalized)', () => {
    const db = defineModels({
      bare: { name: 'bare', tableName: 'bare', schema: UserSchema, primaryKeys: ['id'] },
    });

    expect(db.bare.tableName).toBe('bare');
    expect(db.bare.schema).toBe(UserSchema);
    expect(db.bare.primaryKeys).toEqual(['id']);
    expect(db.bare.relations).toBeUndefined();
    // Normalized: defaults resolved on the wired entry.
    expect(db.bare.id).toBe('uuid');
    expect(db.bare.namePlural).toBe('bares');
  });

  it('preserves loader-facing relation fields (type/foreignKey/localKey) untouched', () => {
    const db = defineModels({
      users: {
        name: 'user',
        tableName: 'users',
        schema: UserSchema,
        primaryKeys: ['id'],
        relations: {
          posts: {
            type: 'hasMany',
            target: 'posts',
            foreignKey: 'authorId',
            localKey: 'id',
          },
        },
      },
      posts: { name: 'post', tableName: 'posts', schema: PostSchema, primaryKeys: ['id'] },
    });

    const posts = db.users.relations?.posts as RelationConfig;
    expect(posts.type).toBe('hasMany');
    expect(posts.foreignKey).toBe('authorId');
    expect(posts.localKey).toBe('id');
  });

  it('wired models remain plain Model objects (wide-assignable, enumerable relations)', () => {
    const db = defineModels(circularInput());
    const models: Model[] = [db.users, db.posts];

    expect(models).toHaveLength(2);
    expect(Object.keys(db.users.relations ?? {})).toEqual(['posts']);
  });
});

describe('defineModelsExtending', () => {
  it('resolves relations against the base map: schema/table auto-populated, key rewritten to the base tableName', () => {
    const tenantsTable = { _: { name: 'tenant_rows', columns: {} } };
    const base = defineModels({
      tenants: {
        name: 'tenant',
        tableName: 'tenant_rows',
        schema: UserSchema,
        primaryKeys: ['id'],
        table: tenantsTable,
      },
    });

    const extended = defineModelsExtending(
      {
        projects: {
          name: 'project',
          tableName: 'projects',
          schema: PostSchema,
          primaryKeys: ['id'],
          relations: {
            tenant: { type: 'belongsTo', target: 'tenants', foreignKey: 'authorId' },
          },
        },
      },
      { extends: base },
    );

    expect(extended.projects.relations?.tenant.schema).toBe(UserSchema);
    expect(extended.projects.relations?.tenant.table).toBe(tenantsTable);
    expect(extended.projects.relations?.tenant.target).toBe('tenant_rows');
  });

  it('returns the base entries alongside the new ones, without re-wiring or replacing them', () => {
    const base = defineModels(circularInput());
    const baseUsers = base.users;

    const extended = defineModelsExtending(
      {
        tags: { name: 'tag', tableName: 'tags', schema: PostSchema, primaryKeys: ['id'] },
      },
      { extends: base },
    );

    expect(extended.users).toBe(baseUsers);
    expect(extended.tags.tableName).toBe('tags');
  });

  it('new entries can also reference each other (same-call siblings win over base keys)', () => {
    const base = defineModels({
      posts: { name: 'post', tableName: 'base_posts', schema: PostSchema, primaryKeys: ['id'] },
    });

    const extended = defineModelsExtending(
      {
        users: {
          name: 'user',
          tableName: 'users',
          schema: UserSchema,
          primaryKeys: ['id'],
          relations: { posts: { type: 'hasMany', target: 'posts', foreignKey: 'authorId' } },
        },
        posts: { name: 'post', tableName: 'new_posts', schema: PostSchema, primaryKeys: ['id'] },
      },
      { extends: base },
    );

    expect(extended.users.relations?.posts.target).toBe('new_posts');
  });

  it('aggregates unknown targets across BOTH keyspaces into one plain Error', () => {
    const base = defineModels({
      tenants: { name: 'tenant', tableName: 'tenants', schema: UserSchema, primaryKeys: ['id'] },
    });

    let caught: unknown;
    try {
      defineModelsExtending(
        {
          projects: {
            name: 'project',
            tableName: 'projects',
            schema: PostSchema,
            primaryKeys: ['id'],
            relations: {
              // @ts-expect-error - deliberately unknown key across both maps (runtime path)
              tenant: { type: 'belongsTo', target: 'tenantz', foreignKey: 'authorId' },
            },
          },
        },
        { extends: base },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor).toBe(Error);
    const message = (caught as Error).message;
    expect(message).toContain("'tenantz'");
    expect(message.toLowerCase()).toContain("did you mean 'tenants'");
    expect(message).toContain('tenants');
    expect(message).toContain('projects');
  });

  it('honors the DefineModelsConfig knobs and freezes only the NEW models', () => {
    const base = defineModels({
      tenants: { name: 'tenant', tableName: 'tenants', schema: UserSchema, primaryKeys: ['id'] },
    });

    const extended = defineModelsExtending(
      {
        projects: {
          name: 'project',
          tableName: 'projects',
          schema: PostSchema,
          primaryKeys: ['id'],
          relations: {
            tenant: { type: 'belongsTo', target: 'tenants', foreignKey: 'authorId' },
          },
        },
      },
      { extends: base, autoPopulateSchema: false, freeze: true },
    );

    expect(extended.projects.relations?.tenant.schema).toBeUndefined();
    expect(extended.projects.relations?.tenant.target).toBe('tenants');
    expect(Object.isFrozen(extended.projects)).toBe(true);
    expect(Object.isFrozen(extended.tenants)).toBe(false);
  });
});

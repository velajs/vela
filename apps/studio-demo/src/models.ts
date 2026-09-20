/**
 * The demo's data model, authored with the REAL crud surface: `defineModels`
 * over real `zod` schemas. `defineModels` normalizes each entry into a crud
 * `Model` (pk/timestamps/soft-delete/relations resolved, relation targets
 * rewritten to the sibling `tableName`), and its `schema.shape` carries the live
 * zod nodes the Studio data browser introspects for column types.
 *
 * Three models with a relation and one soft-delete model, per the brief:
 *  - `author`  — parent; `hasMany` books; a `role` column for facets.
 *  - `book`    — child; `belongsTo` author (FK `authorId`); SOFT-DELETE (`deletedAt`).
 *  - `tag`     — a standalone third model (no relation).
 *
 * NOTE (brief deviation): the brief named `@velajs/crud-memory`, which does not
 * exist in this workspace. crud is BYO-DB, so the demo authors its own tiny
 * in-memory `CrudAdapter` (see `memory-adapter.ts`) — exactly as the server
 * package's own tests do. Everything else is the real published crud API.
 */
import { defineModels } from '@velajs/crud';
import { z } from 'zod';

export const models = defineModels({
  author: {
    name: 'author',
    tableName: 'authors',
    schema: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    }),
    // A non-PK single-column unique (projects `unique: true` on its column).
    unique: [['email']],
    relations: {
      books: { type: 'hasMany', target: 'book', foreignKey: 'authorId' },
    },
  },
  book: {
    name: 'book',
    tableName: 'books',
    schema: z.object({
      id: z.string(),
      title: z.string(),
      authorId: z.string(),
      status: z.string(),
      deletedAt: z.number().nullable().optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    }),
    // Soft delete — tombstone via `deletedAt` instead of a hard row removal.
    softDelete: true,
    unique: [['title']],
    relations: {
      author: { type: 'belongsTo', target: 'author', foreignKey: 'authorId' },
    },
  },
  tag: {
    name: 'tag',
    tableName: 'tags',
    schema: z.object({
      id: z.string(),
      label: z.string(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    }),
    unique: [['label']],
  },
});

/** A convenience alias for the normalized `Model` type. */
export type DemoModels = typeof models;

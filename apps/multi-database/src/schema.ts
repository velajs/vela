import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { defineModel } from '@velajs/crud';

// These two databases intentionally use the same table, model and primary keys.
// Each owns its own SQL migration history and stored rows.
export const items = sqliteTable('items', {
  id: text().primaryKey(),
  title: text().notNull(),
});
export const itemSchema = z.object({ id: z.string(), title: z.string().min(1) });
export const itemModel = defineModel({
  name: 'item',
  tableName: 'items',
  schema: itemSchema,
  id: 'client',
  timestamps: false,
});

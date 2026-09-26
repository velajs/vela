import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { defineModel } from '@velajs/crud';
export const items = pgTable('lifecycle_items', {
  id: text().primaryKey(),
  title: text().notNull(),
});
export const itemSchema = z.object({ id: z.string(), title: z.string().min(1).max(200) });
export const itemModel = defineModel({
  name: 'item',
  tableName: 'lifecycle_items',
  schema: itemSchema,
  id: 'client',
  timestamps: false,
});

import { defineLiveQuery } from '@velajs/live-protocol';
import { z } from 'zod';

/** Portable schema imported by both the server resolver and browser client. */
export const todoListDefinition = defineLiveQuery({
  args: z.object({}),
  result: z.array(z.object({
    id: z.string(),
    text: z.string(),
    createdAt: z.number(),
    optimistic: z.boolean().optional(),
  })),
});

export type Todo = ReturnType<typeof todoListDefinition.result.parse>[number];

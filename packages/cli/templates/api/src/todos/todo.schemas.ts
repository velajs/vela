import { z } from 'zod';

export const Todo = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.string(),
});
export type Todo = z.infer<typeof Todo>;

export const CreateTodo = z.object({
  title: z.string().trim().min(1).max(200),
});
export type CreateTodo = z.infer<typeof CreateTodo>;

export const UpdateTodo = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  completed: z.boolean().optional(),
});
export type UpdateTodo = z.infer<typeof UpdateTodo>;

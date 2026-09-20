import { z } from "zod";
import { defineLiveQuery } from "@velajs/live-protocol";

export const todoSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  done: z.boolean().default(false),
});
export const todoList = defineLiveQuery({ args: z.object({}), result: todoSchema.array() });
export const queries = { "todos.list": todoList };
export type Todo = z.infer<typeof todoSchema>;

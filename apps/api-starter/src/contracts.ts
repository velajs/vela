import { z } from "zod";
import { defineLiveQuery } from "@velajs/live-protocol";
import { defineRoute } from "@velajs/vela/contract";

export const todoSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  done: z.boolean().default(false),
});
export const todoList = defineLiveQuery({
  name: "todos.list",
  args: z.object({}),
  result: todoSchema.array(),
});
export const queries = [todoList];
export type Todo = z.infer<typeof todoSchema>;

/** The signed-in user the `/me` route sends. */
export const meSchema = z.object({ id: z.string(), email: z.string(), name: z.string() });

/** A route contract the browser can share: `/healthz`, public and unauthenticated. */
export const health = defineRoute({
  method: "GET",
  path: "/healthz",
  response: z.object({ ok: z.boolean() }),
});

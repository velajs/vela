import { defineProcedure } from '@velajs/rpc';
import { z } from 'zod';
export const catalog = defineProcedure({
  name: 'catalog.read',
  input: z.string(),
  output: z.object({ id: z.string(), label: z.string() }),
});
export const account = defineProcedure({
  name: 'accounts.read',
  input: z.string(),
  output: z.object({ id: z.string(), active: z.boolean() }),
});

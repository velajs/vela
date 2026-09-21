import { z } from 'zod';
import { defineProcedure } from '../src/index';

export const greet = defineProcedure({
  name: 'greetings.hello',
  input: z.object({ name: z.string().min(1).max(100) }),
  output: z.object({ message: z.string() }),
  idempotent: true,
});

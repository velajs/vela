import {
  Controller,
  Cookie,
  Endpoint,
  Get,
  Ip,
  Module,
  Req,
  createLazyParamDecorator,
  createOpenApiDocument,
  createParamDecorator,
  defineEndpoint,
} from '@velajs/vela';
import type { ExecutionContext, VelaContext } from '@velajs/vela';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { generateClientContract } from './client-contract.js';

const read = defineEndpoint({
  input: z.object({
    param: z.object({ id: z.string() }),
    query: z.object({ view: z.enum(['summary', 'full']).optional() }),
  }),
  output: z.object({ id: z.string(), view: z.string() }),
});

// Server-side context: resolved after guards, never sent by the client.
const CurrentActor = createParamDecorator(
  (_data: undefined, context: ExecutionContext) => context.getModuleId() ?? null,
);
const DeferredActor = createLazyParamDecorator(() => undefined);

it('omits endpoint context parameters from generated client contracts', () => {
  @Controller('/records')
  class PlainRecords {
    @Get('/:id')
    @Endpoint(read)
    read(input: z.output<typeof read.input>) {
      return { id: input.param.id, view: input.query.view ?? 'summary' };
    }
  }
  @Module({ controllers: [PlainRecords] })
  class PlainApp {}

  @Controller('/records')
  class ContextualRecords {
    @Get('/:id')
    @Endpoint(read)
    read(
      input: z.output<typeof read.input>,
      @CurrentActor() _actor: string | null,
      @DeferredActor() _load: () => undefined,
      @Req() _request: VelaContext,
      @Ip() _address: string | null,
      @Cookie('theme') _theme: string | undefined,
    ) {
      return { id: input.param.id, view: input.query.view ?? 'summary' };
    }
  }
  @Module({ controllers: [ContextualRecords] })
  class ContextualApp {}

  const plain = generateClientContract(createOpenApiDocument(PlainApp));
  const contextual = generateClientContract(createOpenApiDocument(ContextualApp));
  expect(contextual.warnings).toEqual([]);
  expect(contextual.source).toContain('"/records/:id"');
  expect(contextual.source).toContain('"view"?: "summary" | "full"');
  // The generated contract is byte-identical to the context-free endpoint.
  expect(contextual.source).toBe(plain.source);
});

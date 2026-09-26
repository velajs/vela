import { createAi, streamText, tool } from '@velajs/ai';
import { stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { deadline, limitStream, privateHeaders, RequestFailure } from './bounds';
import { jsonInput } from './policy';

export const modelId = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const promptSchema = z.object({ prompt: z.string().trim().min(1).max(2048) }).strict();
const routeSchema = z.enum(['direct', 'gateway']);
export const sampleToolInput = z.object({ id: z.literal('sample') }).strict();

export function sampleTool(owner: string, signal: AbortSignal) {
  return tool({
    description: 'Read the authorized synthetic sample for the current operator.',
    inputSchema: sampleToolInput,
    execute: (input) => {
      signal.throwIfAborted();
      // The SDK validates model input; validate again at the operation boundary.
      sampleToolInput.parse(input);
      return { id: 'sample', owner, available: 3 };
    },
  });
}

export async function answer(
  env: Cloudflare.Env,
  owner: string,
  route: string,
  request: Request,
): Promise<Response> {
  const selected = routeSchema.parse(route);
  const operation = deadline(request.signal, 20_000);
  try {
    const { prompt } = promptSchema.parse(await jsonInput(request, operation.signal));
    if (selected === 'gateway' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.AI_GATEWAY_ID))
      throw new RequestFailure(503, 'Invalid gateway configuration');
    operation.signal.throwIfAborted();
    // Built from this request's environment. No process-global binding/provider cache,
    // mutable defaults, client model IDs, gateway overrides or providerOptions.
    const provider = createWorkersAI({
      binding: env.AI,
      ...(selected === 'gateway' ? { gateway: { id: env.AI_GATEWAY_ID, skipCache: true } } : {}),
    });
    const models = createAi({ provider, defaultModel: modelId });
    const result = streamText({
      model: models.model(),
      system: 'Answer briefly about the synthetic sample. Use readSample for its availability.',
      prompt,
      maxOutputTokens: 256,
      maxRetries: 0,
      stopWhen: stepCountIs(2),
      abortSignal: operation.signal,
      tools: { readSample: sampleTool(owner, operation.signal) },
      // SDK text streams can otherwise turn provider failure into an empty 200 body.
      onError: () => operation.abort(new RequestFailure(502, 'Inference failed')),
    });
    const response = result.toTextStreamResponse();
    const body = limitStream(response.body!, 32 * 1024, operation.signal, (reason) => {
      if (reason !== undefined) operation.abort(reason);
      operation.dispose();
    });
    return new Response(body, {
      headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    operation.dispose();
    throw error;
  }
}

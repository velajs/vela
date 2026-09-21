import type { EmbeddingModel, LanguageModel } from 'ai';

import type { Ai, AiProvider, CreateAiOptions, EmbeddingModelInput, ModelInput } from './types';

/**
 * The single model-resolution seam. `createAi` turns a provider into `{ model, embeddingModel }`, where each resolver accepts
 * either a model-id string — resolved through the configured {@link AiProvider}
 * — or a pre-built AI SDK model object, which passes straight through. That one
 * call site is why app code is never locked to a single inference provider:
 * swap the provider (or hand a bring-your-own model object) and every call site
 * follows.
 *
 * ```ts
 * import { createAi, generateText } from '@velajs/ai';
 *
 * const ai = createAi({ provider, defaultModel: 'llama-3.3-70b' });
 * const { text } = await generateText({ model: ai.model(), prompt });
 * ```
 *
 * `@velajs/ai` imports no provider and no platform SDK; the caller supplies the
 * provider; construct it from the current application environment.
 */
export const createAi = (options: CreateAiOptions = {}): Ai => {
  const { provider, defaultModel, defaultEmbeddingModel } = options;

  const requireProvider = (): AiProvider => {
    if (!provider) {
      throw new Error(
        '@velajs/ai: a model-id string was passed but no `provider` is configured — ' +
          'call createAi({ provider }) to resolve string ids, or pass a built AI SDK model object instead',
      );
    }

    return provider;
  };

  const model = (input?: ModelInput): LanguageModel => {
    const resolved = input ?? defaultModel;

    if (resolved === undefined) {
      throw new Error(
        '@velajs/ai: no model supplied and no `defaultModel` configured — ' +
          'pass a model id or an AI SDK model to model(), or set defaultModel on createAi()',
      );
    }

    // A string is a provider model id; anything else is an already-built AI SDK
    // model — pass it through untouched.
    return typeof resolved === 'string' ? requireProvider()(resolved) : resolved;
  };

  const embeddingModel = (input?: EmbeddingModelInput): EmbeddingModel => {
    const resolved = input ?? defaultEmbeddingModel;

    if (resolved === undefined) {
      throw new Error(
        '@velajs/ai: no embedding model supplied and no `defaultEmbeddingModel` configured — ' +
          'pass an embedding model id or an AI SDK embedding model, or set defaultEmbeddingModel on createAi()',
      );
    }

    if (typeof resolved !== 'string') {
      return resolved;
    }

    const embeddingProvider = requireProvider();

    const resolveEmbedding =
      embeddingProvider.embeddingModel ?? embeddingProvider.textEmbeddingModel;
    if (typeof resolveEmbedding !== 'function') {
      throw new Error(
        '@velajs/ai: the configured provider exposes no `embeddingModel` or `textEmbeddingModel` — ' +
          'pass an AI SDK EmbeddingModel object to embeddingModel() instead of a model-id string',
      );
    }

    return resolveEmbedding.call(embeddingProvider, resolved);
  };

  return { model, embeddingModel };
};

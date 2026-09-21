import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * A provider-neutral model factory. Calling it with a model id returns an AI SDK
 * {@link LanguageModel}; the optional `embeddingModel` factory returns an
 * {@link EmbeddingModel}. Callable AI SDK providers satisfy this structurally;
 * `@velajs/ai` imports none of them.
 *
 * The platform adapter is responsible for building one of these. On Cloudflare,
 * that adapter wraps `env.AI` with `workers-ai-provider`; see the CF wiring note
 * in the README. `@velajs/ai` never imports a provider itself.
 */
export interface AiProvider {
  (modelId: string): LanguageModel;
  /** Resolve an embedding model by id. Absent on providers that do not embed. */
  embeddingModel?: (modelId: string) => EmbeddingModel;
  /** Compatibility with providers exposing the earlier embedding factory name. */
  textEmbeddingModel?: (modelId: string) => EmbeddingModel;
}

/**
 * A language model to run against: a plain model-id string (resolved through the
 * configured {@link AiProvider}) or an already-built AI SDK {@link LanguageModel}
 * object (bring-your-own model). The AI SDK's `LanguageModel` already admits a
 * bare string, so this alias is exactly that union.
 */
export type ModelInput = LanguageModel;

/**
 * An embedding model to run against: a model-id string (resolved through the
 * configured provider's embedding factory) or any AI SDK {@link EmbeddingModel}.
 */
export type EmbeddingModelInput = EmbeddingModel | string;

export interface CreateAiOptions {
  /**
   * The provider used to resolve model-id strings. Required to pass a string to
   * `model()` / `embeddingModel()`; omit it if you only ever hand those methods
   * pre-built AI SDK model objects.
   */
  provider?: AiProvider;

  /** Default model used by `model()` when no argument is passed. */
  defaultModel?: ModelInput;

  /** Default embedding model used by `embeddingModel()` when no argument is passed. */
  defaultEmbeddingModel?: EmbeddingModelInput;
}

/**
 * The resolved AI surface returned by {@link createAi}. Feed the model objects
 * from `model()` / `embeddingModel()` to the AI SDK primitives re-exported from
 * `@velajs/ai` (`generateText`, `streamText`, `embed`, `tool`).
 */
export interface Ai {
  /** Resolve a {@link LanguageModel}: a string → provider, an object → passthrough. */
  model: (model?: ModelInput) => LanguageModel;
  /** Resolve an {@link EmbeddingModel}: a string → provider, an object → passthrough. */
  embeddingModel: (model?: EmbeddingModelInput) => EmbeddingModel;
}

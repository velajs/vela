export { createAi } from './create-ai';
export type { Ai, AiProvider, CreateAiOptions, EmbeddingModelInput, ModelInput } from './types';

// Re-export the AI SDK primitives apps reach for at the inference call site, so
// `@velajs/ai` is a single import for the whole surface. `ai` (the Vercel AI
// SDK) is a peer dependency — pass these a model resolved via `createAi(...)` or
// any other AI SDK model.
export type { EmbeddingModel, LanguageModel, Tool } from 'ai';
export { embed, generateText, jsonSchema, streamText, tool } from 'ai';

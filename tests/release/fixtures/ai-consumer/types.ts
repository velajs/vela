import {
  createAi,
  tool,
  type AiProvider,
  type LanguageModel,
  type EmbeddingModel,
} from '@velajs/ai';
import {
  defineRag,
  memoryVectors,
  memoryPublications,
  type Rag,
  type RetrieveResult,
} from '@velajs/ai/rag';
import { createAiSearch, type AiSearch, type AiSearchResult } from '@velajs/ai/ai-search';
import { MockLanguageModelV4, MockEmbeddingModelV4 } from 'ai/test';
import { z } from 'zod';

const provider: AiProvider = Object.assign(
  (modelId: string) => new MockLanguageModelV4({ modelId }),
  {
    embeddingModel: (modelId: string) => new MockEmbeddingModelV4({ modelId }),
  },
);
const models = createAi({ provider, defaultModel: 'chat', defaultEmbeddingModel: 'embed' });
export const model: LanguageModel = models.model();
export const embedding: EmbeddingModel = models.embeddingModel();
export const rag: Rag = defineRag({
  vectors: memoryVectors(),
  publications: memoryPublications(),
  embed: () => [1],
  allowSharedNamespace: true,
});
// Agent memory consumes this structural contract, without depending on a store.
export const retrieve: (
  query: string,
  options?: { topK?: number; namespace?: string; auth?: unknown },
) => Promise<{
  context: string;
  chunks: readonly unknown[];
  sources: readonly unknown[];
}> = rag.retrieve;
export const search = rag.asTool();
export const zodTool = tool({
  inputSchema: z.object({ query: z.string() }),
  execute: ({ query }): Promise<RetrieveResult> => rag.retrieve(query),
});

export const managed: AiSearch = createAiSearch({
  binding: { search: async () => ({ chunks: [] }) },
  instanceIds: ['manuals'],
  authorizeSource: ({ instanceId, key }) => instanceId === 'manuals' && key === 'guide/v1.md',
});
export const managedTool = managed.asTool();
export const managedResult: Promise<AiSearchResult> = managed.retrieve('guide');

export { vectorizeVectors, durableObjectPublications } from '@velajs/ai/vectorize';

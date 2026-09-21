import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EmbeddingModel, LanguageModel, Tool } from '../index';
import { createAi, embed, generateText, jsonSchema, streamText, tool } from '../index';
import type { Ai, AiProvider, ModelInput } from '../index';
import { defineRag, memoryVectors } from '../rag';
import type {
  Rag,
  RagConfig,
  RagSource,
  RagVectors,
  RetrievedChunk,
  RetrieveResult,
  SyncResult,
} from '../rag';

describe('core type surface', () => {
  it('createAi returns the model-resolution seam', () => {
    expectTypeOf(createAi).returns.toEqualTypeOf<Ai>();
    expectTypeOf<Parameters<Ai['model']>[0]>().toEqualTypeOf<ModelInput | undefined>();
    expectTypeOf<ReturnType<Ai['model']>>().toEqualTypeOf<LanguageModel>();
    expectTypeOf<ReturnType<Ai['embeddingModel']>>().toEqualTypeOf<EmbeddingModel>();
    expect(typeof createAi).toBe('function');
  });

  it('AiProvider is a callable factory with an optional embedding factory', () => {
    expectTypeOf<AiProvider>().toBeCallableWith('model-id');
    expectTypeOf<ReturnType<AiProvider>>().toEqualTypeOf<LanguageModel>();
    expectTypeOf<AiProvider['textEmbeddingModel']>().toEqualTypeOf<
      ((modelId: string) => EmbeddingModel) | undefined
    >();
  });

  it('re-exports the AI SDK primitives as callables', () => {
    expectTypeOf(generateText).toBeFunction();
    expectTypeOf(streamText).toBeFunction();
    expectTypeOf(embed).toBeFunction();
    expectTypeOf(tool).toBeFunction();
    expectTypeOf(jsonSchema).toBeFunction();
  });
});

describe('rag type surface', () => {
  it('memoryVectors satisfies the RagVectors seam exactly', () => {
    expectTypeOf<ReturnType<typeof memoryVectors>>().toEqualTypeOf<RagVectors>();
  });

  it('defineRag exposes sync/retrieve/remove/asTool', () => {
    expectTypeOf(defineRag).parameter(0).toEqualTypeOf<RagConfig>();
    expectTypeOf(defineRag).returns.toEqualTypeOf<Rag>();
    expectTypeOf<Awaited<ReturnType<Rag['sync']>>>().toEqualTypeOf<ReadonlyArray<SyncResult>>();
    expectTypeOf<Awaited<ReturnType<Rag['retrieve']>>>().toEqualTypeOf<RetrieveResult>();
    expectTypeOf<Awaited<ReturnType<Rag['remove']>>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<Rag['asTool']>>().toEqualTypeOf<
      Tool<{ query: string }, RetrieveResult>
    >();
  });

  it('RetrieveResult carries context + ranked chunks + deduped sources', () => {
    expectTypeOf<RetrieveResult['context']>().toEqualTypeOf<string>();
    expectTypeOf<RetrieveResult['chunks']>().toEqualTypeOf<ReadonlyArray<RetrievedChunk>>();
    expectTypeOf<RetrieveResult['sources']>().toEqualTypeOf<ReadonlyArray<RagSource>>();
    expectTypeOf<RetrievedChunk['score']>().toEqualTypeOf<number>();
    expectTypeOf<RagSource['weight']>().toEqualTypeOf<number>();
    expect(typeof defineRag).toBe('function');
  });

  it('accepts a sync or async embedder in the config', () => {
    // Both a sync and an async embedder are valid RagConfig.embed values.
    expectTypeOf<RagConfig['embed']>().toBeCallableWith('text');
    const syncEmbed = defineRag({ vectors: memoryVectors(), embed: (t: string) => [t.length] });
    const asyncEmbed = defineRag({
      vectors: memoryVectors(),
      embed: async (t: string) => [t.length],
    });
    expectTypeOf(syncEmbed).toEqualTypeOf<Rag>();
    expectTypeOf(asyncEmbed).toEqualTypeOf<Rag>();
  });
});

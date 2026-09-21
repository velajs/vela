import { describe, expect, it } from 'vitest';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { createAi } from '../index';
import type { AiProvider } from '../index';

/**
 * A provider double built from the AI SDK's own mock model classes (real types,
 * no casts). It records the ids it was asked to resolve so a test can prove the
 * seam routed a string through the provider vs. passed an object through.
 */
const recordingProvider = (): { provider: AiProvider; resolved: string[] } => {
  const resolved: string[] = [];

  const base = (modelId: string): LanguageModel => {
    resolved.push(`model:${modelId}`);

    return new MockLanguageModelV4({ modelId });
  };

  const provider: AiProvider = Object.assign(base, {
    textEmbeddingModel: (modelId: string): EmbeddingModel => {
      resolved.push(`embed:${modelId}`);

      return new MockEmbeddingModelV4({ modelId });
    },
  });

  return { provider, resolved };
};

describe('createAi — model resolution seam', () => {
  it('resolves a string model id through the configured provider', () => {
    const { provider, resolved } = recordingProvider();
    const ai = createAi({ provider });

    const model = ai.model('llama-3.3');

    expect(resolved).toEqual(['model:llama-3.3']);
    expect(typeof model === 'string' ? model : model.modelId).toBe('llama-3.3');
  });

  it('passes a built AI SDK model object straight through (provider untouched)', () => {
    const { provider, resolved } = recordingProvider();
    const ai = createAi({ provider });
    const byoModel = new MockLanguageModelV4({ modelId: 'byo' });

    expect(ai.model(byoModel)).toBe(byoModel);
    expect(resolved).toEqual([]);
  });

  it('uses defaultModel when model() is called with no argument', () => {
    const { provider, resolved } = recordingProvider();
    const ai = createAi({ provider, defaultModel: 'default-model' });

    ai.model();

    expect(resolved).toEqual(['model:default-model']);
  });

  it('throws when a string id is passed but no provider is configured', () => {
    const ai = createAi({});
    expect(() => ai.model('some-id')).toThrow(/no `provider` is configured/);
  });

  it('throws when no model and no defaultModel are available', () => {
    const { provider } = recordingProvider();
    const ai = createAi({ provider });
    expect(() => ai.model()).toThrow(/no `defaultModel`/);
  });

  it('resolves an embedding model id through the provider', () => {
    const { provider, resolved } = recordingProvider();
    const ai = createAi({ provider });

    const model = ai.embeddingModel('bge-small');

    expect(resolved).toEqual(['embed:bge-small']);
    expect(typeof model === 'string' ? model : model.modelId).toBe('bge-small');
  });

  it('passes a built embedding model object straight through', () => {
    const { provider } = recordingProvider();
    const ai = createAi({ provider });
    const byoEmbed = new MockEmbeddingModelV4({ modelId: 'byo-embed' });

    expect(ai.embeddingModel(byoEmbed)).toBe(byoEmbed);
  });

  it('throws for an embedding id when the provider has no textEmbeddingModel', () => {
    const provider: AiProvider = (modelId: string) => new MockLanguageModelV4({ modelId });
    const ai = createAi({ provider });

    expect(() => ai.embeddingModel('needs-embeddings')).toThrow(/no `embeddingModel`/);
  });

  it('throws when embeddingModel() has nothing to resolve', () => {
    const { provider } = recordingProvider();
    const ai = createAi({ provider });
    expect(() => ai.embeddingModel()).toThrow(/no `defaultEmbeddingModel`/);
  });
});

describe('AI SDK 7 embedding factories', () => {
  it('prefers embeddingModel and preserves the provider receiver', () => {
    const embedding = new MockEmbeddingModelV4({ modelId: 'modern' });
    const provider: AiProvider = Object.assign(
      (modelId: string) => new MockLanguageModelV4({ modelId }),
      {
        embeddingModel(this: AiProvider, _id: string) {
          expect(this).toBe(provider);
          return embedding;
        },
        textEmbeddingModel: () => {
          throw new Error('deprecated factory must not run');
        },
      },
    );
    expect(createAi({ provider, defaultEmbeddingModel: 'default' }).embeddingModel()).toBe(
      embedding,
    );
  });

  it('keeps model defaults and providers isolated between application instances', () => {
    const first = recordingProvider();
    const second = recordingProvider();
    createAi({ provider: first.provider, defaultModel: 'one' }).model();
    createAi({ provider: second.provider, defaultModel: 'two' }).model();
    expect(first.resolved).toEqual(['model:one']);
    expect(second.resolved).toEqual(['model:two']);
  });
});

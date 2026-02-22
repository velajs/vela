import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  Controller,
  Get,
  Module,
  Injectable,
  MetadataRegistry,
} from '@velajs/vela';
import { CloudflareFactory } from '../cloudflare-factory';
import { AIModule } from '../modules/ai.module';
import { AIService } from '../services/ai.service';
import { clearBindingsRegistry } from '../tokens';

beforeEach(() => {
  MetadataRegistry.clear();
  clearBindingsRegistry();
});

function createMockAI() {
  return {
    run: async (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => ({
      response: `mock response from ${model}`,
      model,
      inputs,
      ...(options ? { options } : {}),
    }),
  };
}

describe('AIModule', () => {
  it('should inject AIService with working run method', async () => {
    const mockAI = createMockAI();

    @Controller('/ai')
    class AIController {
      constructor(private ai: AIService) {}

      @Get('/chat')
      async chat() {
        const result = await this.ai.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [{ role: 'user', content: 'hello' }],
        });
        return result;
      }
    }

    @Module({
      imports: [AIModule.forRoot({ binding: 'AI' })],
      controllers: [AIController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/ai/chat', undefined, { AI: mockAI });
    expect(res.status).toBe(200);
    const data = await res.json() as { response: string; model: string };
    expect(data.response).toBe('mock response from @cf/meta/llama-3.1-8b-instruct');
    expect(data.model).toBe('@cf/meta/llama-3.1-8b-instruct');
  });

  it('should pass options to run', async () => {
    const mockAI = createMockAI();

    @Controller('/ai')
    class AIController {
      constructor(private ai: AIService) {}

      @Get('/stream')
      async stream() {
        const result = await this.ai.run(
          '@cf/meta/llama-3.1-8b-instruct',
          { prompt: 'test' },
          { stream: true },
        );
        return result;
      }
    }

    @Module({
      imports: [AIModule.forRoot({ binding: 'MY_AI' })],
      controllers: [AIController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/ai/stream', undefined, { MY_AI: mockAI });
    expect(res.status).toBe(200);
    const data = await res.json() as { options: { stream: boolean } };
    expect(data.options).toEqual({ stream: true });
  });

  it('should expose raw binding via .binding getter', async () => {
    const mockAI = createMockAI();

    @Controller('/raw')
    class RawController {
      constructor(private ai: AIService) {}

      @Get()
      async test() {
        const binding = this.ai.binding;
        const result = await binding.run('test-model', { prompt: 'raw' });
        return result;
      }
    }

    @Module({
      imports: [AIModule.forRoot({ binding: 'RAW_AI' })],
      controllers: [RawController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/raw', undefined, { RAW_AI: mockAI });
    expect(res.status).toBe(200);
    const data = await res.json() as { model: string };
    expect(data.model).toBe('test-model');
  });

  it('should allow AIService in nested providers', async () => {
    const mockAI = createMockAI();

    @Injectable()
    class ChatService {
      constructor(private ai: AIService) {}
      async chat(prompt: string) {
        return this.ai.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [{ role: 'user', content: prompt }],
        });
      }
    }

    @Controller('/chat')
    class ChatController {
      constructor(private chatService: ChatService) {}

      @Get('/test')
      async test() {
        return this.chatService.chat('hello');
      }
    }

    @Module({
      imports: [AIModule.forRoot({ binding: 'AI' })],
      providers: [ChatService],
      controllers: [ChatController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/chat/test', undefined, { AI: mockAI });
    expect(res.status).toBe(200);
    const data = await res.json() as { response: string };
    expect(data.response).toContain('mock response');
  });
});

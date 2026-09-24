import { expect, it } from 'vitest';
import { z } from 'zod';
import { Controller, Module, Post, VelaFactory } from '../../index';
import { Endpoint, createOpenApiDocument, defineEndpoint } from '../../openapi/index';

const input = z.object({ json: z.object({ name: z.string().min(1) }) });
const output = z.object({ greeting: z.string() });
const greet = defineEndpoint({ input, output, status: 201 });

@Controller('/greetings')
class Greetings {
  @Post()
  @Endpoint(greet)
  create(value: z.output<typeof input>) {
    return { greeting: `Hello, ${value.json.name}` };
  }
}
@Module({ controllers: [Greetings] })
class App {}

it('uses the same schema at the HTTP and OpenAPI boundaries inside bare workerd', async () => {
  const app = await VelaFactory.create(App);
  try {
    const invalid = await app.fetch(
      new Request('http://example.test/greetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      }),
    );
    expect(invalid.status).toBe(400);
    const response = await app.fetch(
      new Request('http://example.test/greetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ greeting: 'Hello, Ada' });
    const operation = createOpenApiDocument(App).paths['/greetings']?.post;
    expect(operation?.responses['201']?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { greeting: { type: 'string' } },
    });
  } finally {
    await app.close();
  }
});

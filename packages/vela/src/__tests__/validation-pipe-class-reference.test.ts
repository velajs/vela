import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Body, Controller, Injectable, Module, Post, UsePipes, VelaFactory } from '../index.js';
import { ValidationPipe } from '../validation/index.js';
import type { ArgumentMetadata, Type } from '../index.js';
import type { PipeType } from '../module-kit.js';

// A class metatype that carries its schema: the handler's `design:paramtypes`
// hands it to a ValidationPipe constructed without an explicit schema.
class CreateNote {
  static readonly schema = z.object({ title: z.string().min(1) });
}

// Inherits the base constructor and its @Optional() parser metadata.
class TrimmingValidationPipe extends ValidationPipe {
  override transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const trimmed =
      value !== null && typeof value === 'object' && 'title' in value
        ? { ...value, title: String(value.title).trim() }
        : value;
    return super.transform(trimmed, metadata);
  }
}

// Declares its own constructor and fixes the schema itself.
@Injectable()
class NotePipe extends ValidationPipe {
  constructor() {
    super(CreateNote.schema);
  }
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function exercise(module: Type, globalPipes: PipeType[] = []): Promise<void> {
  const app = await VelaFactory.create(module);
  app.useGlobalPipes(...globalPipes);
  const hono = app.getHonoApp();

  const valid = await hono.request('/notes', postJson({ title: 'Plan' }));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ title: 'Plan' });

  const invalid = await hono.request('/notes', postJson({ title: '' }));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    error: { code: 'bad_request', message: 'Validation failed' },
  });
  await app.close();
}

describe('ValidationPipe referenced by class', () => {
  it('builds @UsePipes(ValidationPipe) without a provider registration', async () => {
    @Controller('/notes')
    class NotesController {
      @Post()
      @UsePipes(ValidationPipe)
      create(@Body() body: CreateNote) {
        return body;
      }
    }
    @Module({ controllers: [NotesController] })
    class AppModule {}

    await exercise(AppModule);
  });

  it('builds @Body(ValidationPipe) without a provider registration', async () => {
    @Controller('/notes')
    class NotesController {
      @Post()
      create(@Body(ValidationPipe) body: CreateNote) {
        return body;
      }
    }
    @Module({ controllers: [NotesController] })
    class AppModule {}

    await exercise(AppModule);
  });

  it('builds app.useGlobalPipes(ValidationPipe) without a provider registration', async () => {
    @Controller('/notes')
    class NotesController {
      @Post()
      create(@Body() body: CreateNote) {
        return body;
      }
    }
    @Module({ controllers: [NotesController] })
    class AppModule {}

    await exercise(AppModule, [ValidationPipe]);
  });

  it('builds subclasses that inherit or replace the optional parser parameter', async () => {
    @Controller('/notes')
    class NotesController {
      @Post()
      @UsePipes(TrimmingValidationPipe)
      create(@Body() body: CreateNote) {
        return body;
      }
    }
    @Module({ controllers: [NotesController] })
    class InheritedModule {}
    await exercise(InheritedModule);

    @Controller('/notes')
    class ExplicitController {
      @Post()
      create(@Body(NotePipe) body: unknown) {
        return body;
      }
    }
    @Module({ controllers: [ExplicitController] })
    class ExplicitModule {}
    await exercise(ExplicitModule);
  });
});

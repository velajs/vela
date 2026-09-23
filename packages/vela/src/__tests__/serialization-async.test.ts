import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import {
  Controller,
  Get,
  Module,
  SERIALIZE_METADATA,
  Serialize,
  SerializerInterceptor,
  UseInterceptors,
  VelaFactory,
  type VelaApplication,
} from '../index';
import { MetadataRegistry } from '../module-kit';
import { defineDto } from '../validation/index';

const apps: VelaApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.dispose()));
});

describe('asynchronous response serialization', () => {
  it('awaits each legacy parser once and preserves array order and empty arrays', async () => {
    const row = z.object({ id: z.number() });
    const parse = vi.fn(async (value: unknown) => row.parse(value));

    @Controller('/legacy')
    @UseInterceptors(SerializerInterceptor)
    class Legacy {
      @Get()
      @Serialize({ schema: { parse } })
      list() {
        return [
          { id: 2, secret: 'hidden' },
          { id: 1, secret: 'hidden' },
        ];
      }

      @Get('/empty')
      @Serialize({ schema: { parse } })
      empty() {
        return [];
      }
    }
    @Module({ controllers: [Legacy] })
    class App {}
    const app = await VelaFactory.create(App);
    apps.push(app);
    expect(await (await app.getHonoApp().request('/legacy')).json()).toEqual([
      { id: 2 },
      { id: 1 },
    ]);
    expect(await (await app.getHonoApp().request('/legacy/empty')).json()).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('executes Standard Schema-only DTOs for scalar and array results', async () => {
    const dto = defineDto(v.object({ id: v.pipe(v.string(), v.transform(Number)) }));
    @Controller('/standard')
    @UseInterceptors(SerializerInterceptor)
    class Standard {
      @Get()
      @Serialize(dto)
      scalar() {
        return { id: '1', secret: 'hidden' };
      }

      @Get('/list')
      @Serialize(dto)
      list() {
        return [{ id: '2', secret: 'hidden' }];
      }
    }
    @Module({ controllers: [Standard] })
    class App {}
    const app = await VelaFactory.create(App);
    apps.push(app);
    expect(await (await app.getHonoApp().request('/standard')).json()).toEqual({ id: 1 });
    expect(await (await app.getHonoApp().request('/standard/list')).json()).toEqual([{ id: 2 }]);
  });

  it('invokes async Zod transforms once for each scalar and array item', async () => {
    const transform = vi.fn(async (value: { id: number }) => ({ publicId: value.id }));
    const dto = defineDto(z.object({ id: z.number() }).transform(transform));
    @Controller('/transform')
    @UseInterceptors(SerializerInterceptor)
    class Transform {
      @Get()
      @Serialize(dto)
      scalar() {
        return { id: 1, secret: 'hidden' };
      }

      @Get('/list')
      @Serialize(dto)
      list() {
        return [
          { id: 2, secret: 'hidden' },
          { id: 3, secret: 'hidden' },
        ];
      }
    }
    @Module({ controllers: [Transform] })
    class App {}
    const app = await VelaFactory.create(App);
    apps.push(app);
    expect(await (await app.getHonoApp().request('/transform')).json()).toEqual({ publicId: 1 });
    expect(await (await app.getHonoApp().request('/transform/list')).json()).toEqual([
      { publicId: 2 },
      { publicId: 3 },
    ]);
    expect(transform.mock.calls.map(([value]) => value)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('awaits asynchronous schema refinements and treats invalid output as a server error', async () => {
    const dto = defineDto(
      z.object({ id: z.string().refine(async (value) => value !== 'invalid') }),
    );
    @Controller('/refinement')
    @UseInterceptors(SerializerInterceptor)
    class Refinement {
      @Get()
      @Serialize(dto)
      valid() {
        return [{ id: 'valid', secret: 'hidden' }];
      }

      @Get('/invalid')
      @Serialize(dto)
      invalid() {
        return [{ id: 'invalid' }];
      }
    }
    @Module({ controllers: [Refinement] })
    class App {}
    const app = await VelaFactory.create(App);
    apps.push(app);
    expect(await (await app.getHonoApp().request('/refinement')).json()).toEqual([{ id: 'valid' }]);
    const invalid = await app.getHonoApp().request('/refinement/invalid');
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).not.toContain('invalid');
  });

  it('fails closed when serializer metadata contains an unsupported schema', async () => {
    @Controller('/malformed')
    @UseInterceptors(SerializerInterceptor)
    class Malformed {
      @Get()
      @Serialize({ schema: z.object({ id: z.number() }) })
      one() {
        return { id: 1, secret: 'private-value' };
      }
    }
    @Module({ controllers: [Malformed] })
    class App {}
    MetadataRegistry.setCustomHandlerMeta(Malformed, 'one', SERIALIZE_METADATA, { schema: {} });
    const app = await VelaFactory.create(App);
    apps.push(app);
    const response = await app.getHonoApp().request('/malformed');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-value');
  });
});

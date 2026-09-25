import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import { Controller, Get, Module, VelaFactory, type VelaApplication } from '../index';
import { defineDto } from '../validation/index';

const apps: VelaApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.dispose()));
});

async function start(controller: new () => object): Promise<VelaApplication> {
  @Module({ controllers: [controller] })
  class App {}
  const app = await VelaFactory.create(App);
  apps.push(app);
  return app;
}

describe('asynchronous response schemas', () => {
  it('awaits a parse() parser once per response and preserves array order', async () => {
    const rows = z.array(z.object({ id: z.number() }));
    const parse = vi.fn(async (value: unknown) => rows.parse(value));

    @Controller('/legacy')
    class Legacy {
      @Get({ response: { parse } })
      list() {
        return [
          { id: 2, secret: 'hidden' },
          { id: 1, secret: 'hidden' },
        ];
      }

      @Get('/empty', { response: { parse } })
      empty() {
        return [];
      }
    }
    const app = await start(Legacy);
    expect(await (await app.getHonoApp().request('/legacy')).json()).toEqual([
      { id: 2 },
      { id: 1 },
    ]);
    expect(await (await app.getHonoApp().request('/legacy/empty')).json()).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('executes Standard Schema-only DTOs for scalar and array results', async () => {
    const row = v.object({ id: v.pipe(v.string(), v.transform(Number)) });
    const dto = defineDto(row);
    @Controller('/standard')
    class Standard {
      @Get({ response: dto })
      scalar() {
        return { id: '1', secret: 'hidden' };
      }

      @Get('/list', { response: v.array(row) })
      list() {
        return [{ id: '2', secret: 'hidden' }];
      }
    }
    const app = await start(Standard);
    expect(await (await app.getHonoApp().request('/standard')).json()).toEqual({ id: 1 });
    expect(await (await app.getHonoApp().request('/standard/list')).json()).toEqual([{ id: 2 }]);
  });

  it('invokes async Zod transforms once for each scalar and array item', async () => {
    const transform = vi.fn(async (value: { id: number }) => ({ publicId: value.id }));
    const item = z.object({ id: z.number() }).transform(transform);
    @Controller('/transform')
    class Transform {
      @Get({ response: defineDto(item) })
      scalar() {
        return { id: 1, secret: 'hidden' };
      }

      @Get('/list', { response: z.array(item) })
      list() {
        return [
          { id: 2, secret: 'hidden' },
          { id: 3, secret: 'hidden' },
        ];
      }
    }
    const app = await start(Transform);
    expect(await (await app.getHonoApp().request('/transform')).json()).toEqual({ publicId: 1 });
    expect(await (await app.getHonoApp().request('/transform/list')).json()).toEqual([
      { publicId: 2 },
      { publicId: 3 },
    ]);
    expect(transform.mock.calls.map(([value]) => value)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('awaits asynchronous schema refinements and treats invalid output as a server error', async () => {
    const rows = z.array(z.object({ id: z.string().refine(async (value) => value !== 'invalid') }));
    @Controller('/refinement')
    class Refinement {
      @Get({ response: rows })
      valid() {
        return [{ id: 'valid', secret: 'hidden' }];
      }

      @Get('/invalid', { response: rows })
      invalid() {
        return [{ id: 'invalid' }];
      }
    }
    const app = await start(Refinement);
    expect(await (await app.getHonoApp().request('/refinement')).json()).toEqual([{ id: 'valid' }]);
    const invalid = await app.getHonoApp().request('/refinement/invalid');
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).not.toContain('invalid');
  });

  it('fails closed when a response schema cannot parse', async () => {
    @Controller('/malformed')
    class Malformed {
      // @ts-expect-error a response schema parses: it is a Standard Schema, parser or descriptor
      @Get({ response: {} })
      one() {
        return { id: 1, secret: 'private-value' };
      }
    }
    const app = await start(Malformed);
    const response = await app.getHonoApp().request('/malformed');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-value');
  });
});

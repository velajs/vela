import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Controller, Ctx, Delete, Module, Post, VelaFactory, type VelaContext } from '../index';
import { defineRoute } from '../contract/index';

// A bundler drops `@Body`, `@Query` and `@Param` from a Worker that uses none
// of them, and with them the reader that validates declared request input.
vi.mock('../http/route-input-registry', () => ({
  installRouteInput: () => {},
  routeInputReader: () => undefined,
}));

const purge = defineRoute({
  method: 'DELETE',
  path: '/tasks/:id',
  params: z.object({ id: z.uuid() }),
  response: null,
});

async function start(controller: new () => object) {
  @Module({ controllers: [controller] })
  class App {}
  return VelaFactory.create(App);
}

describe('declared request input without its reader', () => {
  it('names the missing readers for a contract whose handler reads nothing', async () => {
    @Controller('/tasks')
    class Tasks {
      @Delete('/:id', purge)
      purge(@Ctx() _c: VelaContext) {}
    }
    await expect(start(Tasks)).rejects.toThrow(
      'Tasks.purge: validating its declared request needs the reader @Body, @Query and @Param install, and none of them is in this bundle; read the declared input with one of them',
    );
  });

  it('names the missing readers for a form route whose handler reads nothing', async () => {
    @Controller('/uploads')
    class Uploads {
      @Post('/', { body: { multipart: { maxFiles: 1 } } })
      upload() {
        return { ok: true };
      }
    }
    await expect(start(Uploads)).rejects.toThrow(/^Uploads\.upload: validating its declared/);
  });
});

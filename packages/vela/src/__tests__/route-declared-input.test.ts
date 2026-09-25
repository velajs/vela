import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_EXCEPTION_HANDLER,
  Body,
  Controller,
  defineProvider,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Query,
  RawBody,
  VelaFactory,
  type VelaApplication,
} from '../index';
import { defineRoute, type ContractBody, type ContractParams } from '../contract/index';

// Declared means enforced: a route validates every request group it declares
// once, after guards, whether or not a parameter reads it.

const id = '2f1c2a4e-6f0b-4c1d-9d2e-8a7b6c5d4e3f';
let calls = 0;

const archive = defineRoute({
  method: 'POST',
  path: '/tasks/:id/archive',
  params: z.object({ id: z.uuid() }),
  query: z.object({ confirm: z.literal('yes') }),
  body: z.object({ reason: z.string().min(3) }),
  response: z.object({ ok: z.boolean() }),
});

const purge = defineRoute({
  method: 'DELETE',
  path: '/tasks/:id',
  params: z.object({ id: z.uuid() }),
  query: z.object({ confirm: z.literal('yes') }),
  response: null,
});

@Controller('/tasks')
class Tasks {
  // Reads only the path parameter.
  @Post('/:id/archive', archive)
  archiveIt(@Param('id') _id: string) {
    calls++;
    return { ok: true };
  }

  // Reads nothing.
  @Delete('/:id', purge)
  purgeIt() {
    calls++;
  }

  // Declares an upload it never reads with @Body().
  @Post('/import', { body: { multipart: { maxFiles: 1, maxFileBytes: 64 } } })
  importIt() {
    calls++;
    return { ok: true };
  }

  // Bounds a JSON body it reads twice: parsed, then as raw bytes.
  @Post('/notes', { body: { json: { maxBytes: 64 } } })
  note(@Body() body: unknown, @RawBody() raw: Uint8Array) {
    return { body, bytes: raw.byteLength };
  }
}

async function start(controller: new () => object = Tasks) {
  @Module({ controllers: [controller] })
  class App {}
  return VelaFactory.create(App);
}

function send(app: VelaApplication, method: string, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://example.test${path}`, { method, ...init }));
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('declared request groups', () => {
  it('validates every group a contract declares when a parameter reads only one', async () => {
    const app = await start();
    try {
      calls = 0;
      const path = `/tasks/${id}/archive`;
      const plain = await send(app, 'POST', `${path}?confirm=yes`, {
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      expect(plain.status).toBe(415);
      expect((await send(app, 'POST', path, json({ reason: 'done' }))).status).toBe(400);
      expect((await send(app, 'POST', `${path}?confirm=yes`, json({ reason: 'x' }))).status).toBe(
        400,
      );
      expect(
        (await send(app, 'POST', `/tasks/nope/archive?confirm=yes`, json({ reason: 'done' })))
          .status,
      ).toBe(400);
      expect(calls).toBe(0);
      const archived = await send(app, 'POST', `${path}?confirm=yes`, json({ reason: 'done' }));
      expect(archived.status).toBe(201);
      expect(await archived.json()).toEqual({ ok: true });
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('validates the groups of a contract whose handler reads nothing', async () => {
    const app = await start();
    try {
      calls = 0;
      expect((await send(app, 'DELETE', `/tasks/${id}`)).status).toBe(400);
      expect((await send(app, 'DELETE', '/tasks/nope?confirm=yes')).status).toBe(400);
      expect(calls).toBe(0);
      expect((await send(app, 'DELETE', `/tasks/${id}?confirm=yes`)).status).toBe(204);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('enforces a declared form encoding and its limits when no parameter reads the body', async () => {
    const app = await start();
    try {
      calls = 0;
      expect((await send(app, 'POST', '/tasks/import', json({ file: 'x' }))).status).toBe(415);
      const files = new FormData();
      files.append('a', new File(['a'], 'a.txt'));
      files.append('b', new File(['b'], 'b.txt'));
      expect((await send(app, 'POST', '/tasks/import', { body: files })).status).toBe(413);
      const large = new FormData();
      large.append('a', new File([new Uint8Array(65)], 'a.bin'));
      expect((await send(app, 'POST', '/tasks/import', { body: large })).status).toBe(413);
      expect(calls).toBe(0);
      const one = new FormData();
      one.append('a', new File(['a'], 'a.txt'));
      expect((await send(app, 'POST', '/tasks/import', { body: one })).status).toBe(201);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('lets a later parameter read a bounded body again', async () => {
    const app = await start();
    try {
      const response = await send(app, 'POST', '/tasks/notes', json({ a: 1 }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ body: { a: 1 }, bytes: 7 });
    } finally {
      await app.close();
    }
  });

  it('fails to start when a params schema leaves out a path parameter', async () => {
    const read = defineRoute({
      method: 'GET',
      path: '/orgs/:org/tasks/:id',
      params: z.object({ id: z.string() }),
      response: z.object({ org: z.string(), id: z.string() }),
    });
    @Controller('/orgs/:org/tasks')
    class OrgTasks {
      @Get('/:id', read)
      read(@Param('org') org: string, @Param('id') taskId: string) {
        return { org, id: taskId };
      }
    }
    await expect(start(OrgTasks)).rejects.toThrow(
      /OrgTasks\.read: its params schema does not declare the path parameter org/,
    );
  });

  it('fails to start when a named parameter reads a key its group does not declare', async () => {
    const list = defineRoute({
      method: 'GET',
      path: '/reports',
      query: z.object({ page: z.string().optional() }),
      response: z.object({ tenant: z.string().nullable() }),
    });
    @Controller('/reports')
    class Reports {
      @Get(list)
      list(@Query('tenant') tenant: string | undefined) {
        return { tenant: tenant ?? null };
      }
    }
    await expect(start(Reports)).rejects.toThrow(
      /Reports\.list: @Query\('tenant'\) reads a key the route's query schema does not declare/,
    );
  });

  it('fails to start when a parameter declares a schema for a group the contract declares', async () => {
    const create = defineRoute({
      method: 'POST',
      path: '/drafts',
      body: z.object({ title: z.string() }),
    });
    @Controller('/drafts')
    class Drafts {
      @Post(create)
      create(@Body(z.object({ title: z.string().min(1) })) body: ContractBody<typeof create>) {
        return body;
      }
    }
    await expect(start(Drafts)).rejects.toThrow(
      /Drafts\.create: the route declares the body schema; remove the schema from @Body\(\)/,
    );
  });
});

// Serve a controller, collecting the errors the application reports.
async function serve(controller: new () => object) {
  const reported: unknown[] = [];
  @Module({
    controllers: [controller],
    providers: [
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: { report: (error: unknown) => void reported.push(error) },
      }),
    ],
  })
  class App {}
  return { app: await VelaFactory.create(App), reported };
}

const messages = (reported: unknown[]) =>
  reported.map((error) => (error instanceof Error ? error.message : String(error)));

describe('parameters on schemas that cannot list their keys', () => {
  it('checks path parameters against a schema with fields JSON Schema cannot express', async () => {
    const read = defineRoute({
      method: 'GET',
      path: '/orgs/:org/days/:id',
      params: z.object({ id: z.coerce.date() }),
      response: z.object({ org: z.string() }),
    });
    @Controller('/orgs/:org/days')
    class Days {
      @Get('/:id', read)
      read(@Param('org') org: string) {
        return { org };
      }
    }
    await expect(start(Days)).rejects.toThrow(
      /Days\.read: its params schema does not declare the path parameter org/,
    );
  });

  it('answers 500 when a named parameter reads a path parameter its schema dropped', async () => {
    const read = defineRoute({
      method: 'GET',
      path: '/orgs/:org/items/:id',
      params: v.object({ id: v.string() }),
      response: z.object({ org: z.string(), id: z.string() }),
    });
    const parsed = defineRoute({
      method: 'GET',
      path: '/orgs/:org/parsed/:id',
      params: { parse: (value: unknown) => ({ id: String(Reflect.get(Object(value), 'id')) }) },
      response: z.object({ org: z.string(), id: z.string() }),
    });
    calls = 0;
    @Controller('/orgs/:org')
    class Items {
      @Get('/items/:id', read)
      read(@Param('org') org: string, @Param('id') itemId: string) {
        calls++;
        return { org, id: itemId };
      }

      @Get('/parsed/:id', parsed)
      parsed(@Param('org') org: string, @Param('id') itemId: string) {
        calls++;
        return { org, id: itemId };
      }
    }
    const { app, reported } = await serve(Items);
    try {
      expect((await send(app, 'GET', '/orgs/acme/items/1')).status).toBe(500);
      expect((await send(app, 'GET', '/orgs/acme/parsed/1')).status).toBe(500);
      expect(calls).toBe(0);
      expect(messages(reported)).toEqual([
        "Items.read: @Param('org') reads a key the route's params schema does not return",
        "Items.parsed: @Param('org') reads a key the route's params schema does not return",
      ]);
    } finally {
      await app.close();
    }
  });

  it('answers 500 when a whole @Param() reads params its schema dropped a path parameter from', async () => {
    const read = defineRoute({
      method: 'GET',
      path: '/teams/:org/members/:id',
      params: v.object({ id: v.string() }),
      response: z.object({ org: z.string(), id: z.string() }),
    });
    const parsed = defineRoute({
      method: 'GET',
      path: '/teams/:org/parsed/:id',
      params: { parse: (value: unknown) => ({ id: String(Reflect.get(Object(value), 'id')) }) },
      response: z.object({ org: z.string(), id: z.string() }),
    });
    const kept = defineRoute({
      method: 'GET',
      path: '/teams/:org/kept/:id',
      params: v.object({ org: v.string(), id: v.string() }),
      response: z.object({ org: z.string(), id: z.string() }),
    });
    calls = 0;
    @Controller('/teams/:org')
    class Members {
      @Get('/members/:id', read)
      read(@Param() params: Record<string, string | undefined>) {
        calls++;
        return { org: params.org ?? 'none', id: params.id ?? 'none' };
      }

      @Get('/parsed/:id', parsed)
      parsed(@Param() params: Record<string, string | undefined>) {
        calls++;
        return { org: params.org ?? 'none', id: params.id ?? 'none' };
      }

      @Get('/kept/:id', kept)
      kept(@Param() params: ContractParams<typeof kept>) {
        return params;
      }
    }
    const { app, reported } = await serve(Members);
    try {
      expect((await send(app, 'GET', '/teams/acme/members/1')).status).toBe(500);
      expect((await send(app, 'GET', '/teams/acme/parsed/1')).status).toBe(500);
      expect(calls).toBe(0);
      const response = await send(app, 'GET', '/teams/acme/kept/1');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ org: 'acme', id: '1' });
      expect(messages(reported)).toEqual([
        "Members.read: @Param() reads params without the path parameter org; the route's params schema does not return it",
        "Members.parsed: @Param() reads params without the path parameter org; the route's params schema does not return it",
      ]);
    } finally {
      await app.close();
    }
  });

  it('answers 500 when a named query parameter reads a key its schema dropped', async () => {
    const list = defineRoute({
      method: 'GET',
      path: '/ledger',
      query: v.object({ page: v.optional(v.string()) }),
      response: z.object({ tenant: z.string().nullable() }),
    });
    @Controller('/ledger')
    class Ledger {
      @Get(list)
      list(@Query('tenant') tenant: string | undefined) {
        return { tenant: tenant ?? null };
      }
    }
    const { app, reported } = await serve(Ledger);
    try {
      const absent = await send(app, 'GET', '/ledger?page=1');
      expect(absent.status).toBe(200);
      expect(await absent.json()).toEqual({ tenant: null });
      expect((await send(app, 'GET', '/ledger?tenant=a')).status).toBe(500);
      expect(messages(reported)).toEqual([
        "Ledger.list: @Query('tenant') reads a key the route's query schema does not return",
      ]);
    } finally {
      await app.close();
    }
  });

  it('answers 500 when a named body parameter reads a member its schema dropped', async () => {
    const create = defineRoute({
      method: 'POST',
      path: '/memos',
      body: v.object({ title: v.string() }),
      response: z.object({ owner: z.string().nullable() }),
    });
    @Controller('/memos')
    class Memos {
      @Post(create)
      create(@Body('owner') owner: string | undefined) {
        return { owner: owner ?? null };
      }
    }
    const { app, reported } = await serve(Memos);
    try {
      const plain = await send(app, 'POST', '/memos', json({ title: 'a' }));
      expect(plain.status).toBe(201);
      expect(await plain.json()).toEqual({ owner: null });
      expect((await send(app, 'POST', '/memos', json({ title: 'a', owner: 'b' }))).status).toBe(
        500,
      );
      expect(messages(reported)).toEqual([
        "Memos.create: @Body('owner') reads a key the route's body schema does not return",
      ]);
    } finally {
      await app.close();
    }
  });

  it('reads the keys a transforming schema returns, not the keys it accepts', async () => {
    const read = defineRoute({
      method: 'GET',
      path: '/notes/:id',
      params: z.object({ id: z.string() }).transform((value) => ({ noteId: value.id })),
      response: z.object({ id: z.string() }),
    });
    const stale = defineRoute({
      method: 'GET',
      path: '/notes/:id/stale',
      params: z.object({ id: z.string() }).transform((value) => ({ noteId: value.id })),
      response: z.object({ id: z.string() }),
    });
    @Controller('/notes')
    class Notes {
      @Get('/:id', read)
      read(@Param('noteId') noteId: string) {
        return { id: noteId };
      }

      @Get('/:id/stale', stale)
      stale(@Param('id') noteId: string) {
        return { id: noteId };
      }
    }
    const { app, reported } = await serve(Notes);
    try {
      const response = await send(app, 'GET', '/notes/n1');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'n1' });
      expect((await send(app, 'GET', '/notes/n1/stale')).status).toBe(500);
      expect(messages(reported)).toEqual([
        "Notes.stale: @Param('id') reads a key the route's params schema does not return",
      ]);
    } finally {
      await app.close();
    }
  });
});

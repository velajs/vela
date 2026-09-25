import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { Controller, Get, Module, VelaFactory, defineSerializer } from '../index';
import { createOpenApiDocument } from '../openapi/index';

class Account {
  #id: string;
  #created: Date;
  #password: string;

  constructor(id: string, password: string) {
    this.#id = id;
    this.#created = new Date('2026-09-21T12:00:00.000Z');
    this.#password = password;
  }

  publicDetails() {
    return { id: this.#id, createdAt: this.#created.toISOString() };
  }

  matchesPassword(password: string) {
    return password === this.#password;
  }
}

describe('explicit domain serialization', () => {
  it('projects private domain state and validates each boundary exactly once', async () => {
    const domainParse = vi.fn((value: unknown) => z.instanceof(Account).parse(value));
    const project = vi.fn(async (account: Account) => ({
      ...account.publicDetails(),
      ignored: true,
    }));
    const outputParse = vi.fn(async (value: unknown) =>
      z.object({ id: z.string(), createdAt: z.iso.datetime() }).parse(value),
    );
    const serializer = defineSerializer({
      input: z.unknown().transform(domainParse),
      output: z.object({ id: z.string(), createdAt: z.string() }).transform(outputParse),
      project,
    });
    const account = new Account('a1', 'secret');
    expect(await serializer.serialize(account)).toEqual({
      id: 'a1',
      createdAt: '2026-09-21T12:00:00.000Z',
    });
    expect(domainParse).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
    expect(outputParse).toHaveBeenCalledTimes(1);
    expect(account.matchesPassword('secret')).toBe(true);
    expect(Object.isFrozen(serializer)).toBe(true);
    expect(Object.isFrozen(serializer['~standard'])).toBe(true);
  });

  it('rejects foreign values before invoking the typed projection', async () => {
    const project = vi.fn((account: Account) => account.publicDetails());
    const serializer = defineSerializer({
      input: z.instanceof(Account),
      output: z.object({ id: z.string(), createdAt: z.string() }),
      project,
    });
    await expect(serializer.parse({ id: 'not-an-account' })).rejects.toThrow();
    expect(project).not.toHaveBeenCalled();
  });

  it('validates transformed wire output and propagates projection failures', async () => {
    const serializer = defineSerializer({
      input: v.string(),
      output: v.pipe(v.string(), v.transform(Number), v.finite()),
      project: (value) => value,
    });
    expect(await serializer.serialize('42')).toBe(42);
    await expect(serializer.serialize('invalid')).rejects.toThrow();

    const failure = new Error('projection failed');
    const failing = defineSerializer({
      input: z.string(),
      output: z.string(),
      project: async () => {
        throw failure;
      },
    });
    await expect(failing.serialize('value')).rejects.toBe(failure);
  });

  it('accepts schema input before supplying the transformed value to the projection', async () => {
    const parseInput = vi.fn(Number);
    const project = vi.fn((value: number) => value * 2);
    const serializer = defineSerializer({
      input: v.pipe(v.string(), v.transform(parseInput)),
      output: v.number(),
      project,
    });
    expect(await serializer.serialize('21')).toBe(42);
    expect(parseInput).toHaveBeenCalledExactlyOnceWith('21');
    expect(project).toHaveBeenCalledExactlyOnceWith(21);
  });

  it('executes async Zod input and output transforms once around the projection', async () => {
    const inputTransform = vi.fn(async (id: string) => new Account(id, 'secret'));
    const outputTransform = vi.fn(async (value: { id: string }) => ({ publicId: value.id }));
    const project = vi.fn((account: Account) => account.publicDetails());
    const serializer = defineSerializer({
      input: z.string().transform(inputTransform),
      output: z.object({ id: z.string() }).transform(outputTransform),
      project,
    });
    expect(await serializer.serialize('a1')).toEqual({ publicId: 'a1' });
    expect(inputTransform).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(1);
    expect(outputTransform).toHaveBeenCalledTimes(1);
  });

  it('serves as a route response: the handler returns the domain value, the route sends the projection', async () => {
    const wire = v.object({ id: v.string(), createdAt: v.string() });
    const one = defineSerializer({
      input: z.instanceof(Account),
      output: wire,
      project: (account) => account.publicDetails(),
    });
    const many = defineSerializer({
      input: z.array(z.instanceof(Account)),
      output: v.array(wire),
      project: (accounts) => accounts.map((account) => account.publicDetails()),
    });
    const shared = new Account('same', 'secret');
    @Controller('/accounts')
    class Accounts {
      @Get({ response: many })
      list() {
        return [shared, shared];
      }

      @Get('/one', { response: one })
      one() {
        return shared;
      }
    }
    @Module({ controllers: [Accounts] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(await (await app.getHonoApp().request('/accounts')).json()).toEqual([
        shared.publicDetails(),
        shared.publicDetails(),
      ]);
      expect(await (await app.getHonoApp().request('/accounts/one')).json()).toEqual(
        shared.publicDetails(),
      );
    } finally {
      await app.dispose();
    }
  });

  it('documents the wire schema of a serializer response', () => {
    const serializer = defineSerializer({
      input: z.instanceof(Account),
      output: z.object({ id: z.string(), createdAt: z.string() }),
      project: (account) => account.publicDetails(),
    });
    @Controller('/documented')
    class Documented {
      @Get({ response: serializer })
      one() {
        return new Account('a', 'secret');
      }
    }
    @Module({ controllers: [Documented] })
    class App {}
    const schema =
      createOpenApiDocument(App).paths['/documented']!.get!.responses['200']!.content![
        'application/json'
      ]!.schema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, createdAt: { type: 'string' } },
    });
  });
});

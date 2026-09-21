import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import {
  Controller,
  Get,
  Module,
  Serialize,
  SerializerInterceptor,
  UseInterceptors,
  VelaFactory,
  defineSerializer,
} from '../index';

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
      input: { parse: domainParse },
      output: { parse: outputParse },
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
    expect(Object.isFrozen(serializer.schema)).toBe(true);
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

  it('uses the same complete projection for @Serialize scalar and array results', async () => {
    const serializer = defineSerializer({
      input: z.instanceof(Account),
      output: v.object({ id: v.string(), createdAt: v.string() }),
      project: (account) => account.publicDetails(),
    });
    const shared = new Account('same', 'secret');
    @Controller('/accounts')
    @UseInterceptors(SerializerInterceptor)
    class Accounts {
      @Get()
      @Serialize(serializer)
      list() {
        return [shared, shared];
      }

      @Get('/one')
      @Serialize(serializer)
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
});

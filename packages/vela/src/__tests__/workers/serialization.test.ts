import { expect, it } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { Controller, Get, Module, VelaFactory, defineSerializer } from '../../index';
import { defineDto } from '../../validation/index';

class Account {
  #name = 'Ada';
  name() {
    return this.#name;
  }
}
const accounts = defineSerializer({
  input: z.array(z.instanceof(Account)),
  output: v.array(v.object({ name: v.string() })),
  project: async (values) => values.map((value) => ({ name: value.name() })),
});
const dto = defineDto(v.object({ id: v.number() }));

@Controller('/serialization')
class Serialized {
  @Get('/accounts', { response: accounts })
  accounts() {
    return [new Account(), new Account()];
  }

  @Get('/dto', { response: dto })
  dto() {
    return { id: 1, secret: 'hidden' };
  }
}
@Module({ controllers: [Serialized] })
class App {}

it('serializes async private-domain projections and Standard DTOs in workerd', async () => {
  const app = await VelaFactory.create(App);
  try {
    const accounts = await app.fetch(new Request('http://example.test/serialization/accounts'));
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toEqual([{ name: 'Ada' }, { name: 'Ada' }]);
    const response = await app.fetch(new Request('http://example.test/serialization/dto'));
    expect(await response.json()).toEqual({ id: 1 });
  } finally {
    await app.dispose();
  }
});

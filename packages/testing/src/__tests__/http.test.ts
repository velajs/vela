import { describe, it, expect } from 'vitest';
import {
  Controller,
  Get,
  Post,
  Body,
  Headers as HeadersParam,
  HttpCode,
  Module,
} from '@velajs/vela';
import { Test } from '../test.js';
import type { TestingModule } from '../testing-module.js';

@Controller('/items')
class ItemsController {
  private items = [{ id: 1, name: 'Item 1' }];

  @Get()
  findAll() {
    return { data: this.items };
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: { name: string }) {
    return { name: body.name, created: true };
  }

  @Get('/whoami')
  whoami(@HeadersParam('authorization') auth: string | undefined) {
    return { auth: auth ?? null };
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

async function compile(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [ItemsModule] }).compile();
}

describe('module.http', () => {
  it('GET returns JSON and assertOk chains', async () => {
    const module = await compile();
    const res = await module.http.get('/items').send();
    res.assertOk();
    await res.assertJsonPath('data.0.name', 'Item 1');
  });

  it('POST with body echoes it and asserts 201', async () => {
    const module = await compile();
    const res = await module.http.post('/items').withBody({ name: 'A' }).send();
    res.assertCreated();
    await res.assertJsonPath('name', 'A');
    await res.assertJsonPath('created', true);
  });

  it('withHeaders forwards custom headers', async () => {
    const module = await compile();
    const res = await module.http
      .get('/items/whoami')
      .withHeaders({ Authorization: 'Bearer token-123' })
      .send();
    await res.assertJsonPath('auth', 'Bearer token-123');
  });

  it('forHost sets the Host header on a new client', async () => {
    const module = await compile();
    const res = await module.http.forHost('example.com').get('/items').send();
    res.assertOk();
  });

  it('actingAs applies headers from an explicit resolver', async () => {
    const module = await compile();
    const res = await module.http
      .get('/items/whoami')
      .actingAs({ id: 'u-1' }, async (_m, principal) => {
        const h = new Headers();
        h.set('Authorization', `Bearer session-for-${String(principal.id)}`);
        return h;
      })
      .send();
    await res.assertJsonPath('auth', 'Bearer session-for-u-1');
  });

  it('actingAs uses a module-level default resolver when none is passed', async () => {
    const module = await compile();
    module.setAuthResolver(async (_m, principal) => {
      const h = new Headers();
      h.set('Authorization', `Bearer default-${String(principal.id)}`);
      return h;
    });
    const res = await module.http.get('/items/whoami').actingAs({ id: 'u-2' }).send();
    await res.assertJsonPath('auth', 'Bearer default-u-2');
  });

  it('actingAs throws a helpful error when no resolver is available', async () => {
    const module = await compile();
    await expect(module.http.get('/items/whoami').actingAs({ id: 'x' }).send()).rejects.toThrow(
      /auth resolver/i,
    );
  });

  it('404 for an unknown route', async () => {
    const module = await compile();
    const res = await module.http.get('/nope').send();
    res.assertNotFound();
  });
});

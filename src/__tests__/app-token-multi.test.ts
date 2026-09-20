import { defineProvider } from '../container/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  MetadataRegistry,
  Module,
  VelaFactory,
} from '../index.js';
import type { CanActivate } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('APP_* providers across multiple modules', () => {
  it('two modules each declaring APP_GUARD: both guards execute on every request', async () => {
    const calls: string[] = [];

    @Injectable()
    class GuardA implements CanActivate {
      canActivate(): boolean {
        calls.push('A');
        return true;
      }
    }

    @Injectable()
    class GuardB implements CanActivate {
      canActivate(): boolean {
        calls.push('B');
        return true;
      }
    }

    @Module({
      providers: [GuardA, defineProvider(APP_GUARD, {useExisting: GuardA})],
    })
    class FeatureA {}

    @Module({
      providers: [GuardB, defineProvider(APP_GUARD, {useExisting: GuardB})],
    })
    class FeatureB {}

    @Controller('/multi-guard')
    class MultiCtl {
      @Get() handle() {
        return { ok: true };
      }
    }

    @Module({ imports: [FeatureA, FeatureB], controllers: [MultiCtl] })
    class App {}

    const app = await VelaFactory.create(App);
    const res = await app.getHonoApp().request('/multi-guard');
    expect(res.status).toBe(200);
    expect(calls.sort()).toEqual(['A', 'B']);
  });
});

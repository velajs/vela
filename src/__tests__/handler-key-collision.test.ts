import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Controller,
  Get,
  UseGuards,
  Injectable,
  MetadataRegistry,
  type CanActivate,
  type ExecutionContext,
} from '../index.js';

beforeEach(() => { MetadataRegistry.clear(); });

describe('handler-key collision under duplicate class names', () => {
  it('two controllers with the same class.name keep distinct handler-level guards', async () => {
    const calls: string[] = [];

    @Injectable()
    class AllowGuard implements CanActivate {
      canActivate(_: ExecutionContext): boolean {
        calls.push('allow');
        return true;
      }
    }

    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate(_: ExecutionContext): boolean {
        calls.push('deny');
        return false;
      }
    }

    // Build two controllers that both end up named 'C' at runtime.
    const makeAllow = () => {
      @Controller('/a')
      class C {
        @Get()
        @UseGuards(AllowGuard)
        ping() { return 'a-ok'; }
      }
      return C;
    };
    const makeDeny = () => {
      @Controller('/b')
      class C {
        @Get()
        @UseGuards(DenyGuard)
        ping() { return 'b-ok'; }
      }
      return C;
    };

    const A = makeAllow();
    const B = makeDeny();
    expect(A.name).toBe('C');
    expect(B.name).toBe('C');
    expect(A).not.toBe(B);

    @Module({ controllers: [A, B], providers: [AllowGuard, DenyGuard] })
    class App {}

    const app = await VelaFactory.create(App);

    const aRes = await app.fetch(new Request('http://x/a'));
    expect(aRes.status).toBe(200);
    expect(await aRes.text()).toBe('a-ok');

    const bRes = await app.fetch(new Request('http://x/b'));
    expect(bRes.status).toBe(403);

    // Each request should have run only its own guard, not both.
    expect(calls).toEqual(['allow', 'deny']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Module, Controller, Get, Head, Options, MetadataRegistry } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('HTTP method routing', () => {
  describe('@Head()', () => {
    it('responds to HEAD', async () => {
      @Controller('/x')
      class C {
        @Head()
        h() {
          return 'should not be sent as body';
        }
      }

      @Module({ controllers: [C] })
      class App {}

      const app = await VelaFactory.create(App);
      const res = await app.fetch(new Request('http://x/x', { method: 'HEAD' }));
      expect(res.status).toBe(200);
    });

    it('does not respond to GET when only @Head() is registered', async () => {
      @Controller('/x')
      class C {
        @Head()
        h() {
          return 'head-only';
        }
      }

      @Module({ controllers: [C] })
      class App {}

      const app = await VelaFactory.create(App);
      const res = await app.fetch(new Request('http://x/x', { method: 'GET' }));
      expect(res.status).toBe(404);
    });

    it('@Get() and @Head() on the same path coexist', async () => {
      @Controller('/x')
      class C {
        @Get()
        g() {
          return 'get-body';
        }

        @Head()
        h() {
          return null;
        }
      }

      @Module({ controllers: [C] })
      class App {}

      const app = await VelaFactory.create(App);
      const getRes = await app.fetch(new Request('http://x/x'));
      expect(getRes.status).toBe(200);
      expect(await getRes.text()).toBe('get-body');

      const headRes = await app.fetch(new Request('http://x/x', { method: 'HEAD' }));
      expect(headRes.status).toBe(200);
    });
  });

  describe('@Options()', () => {
    it('responds to OPTIONS only', async () => {
      @Controller('/x')
      class C {
        @Options()
        o() {
          return 'opts';
        }
      }

      @Module({ controllers: [C] })
      class App {}

      const app = await VelaFactory.create(App);
      const optRes = await app.fetch(new Request('http://x/x', { method: 'OPTIONS' }));
      expect(optRes.status).toBe(200);

      const getRes = await app.fetch(new Request('http://x/x'));
      expect(getRes.status).toBe(404);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  VelaFactory,
  Module,
  Controller,
  Get,
  Param,
  Version,
  ApiDoc,
  UrlGeneratorService,
  createOpenApiDocument,
} from '../index.js';

describe('named routes + URL generation', () => {
  describe('route name reaches describeRoutes()', () => {
    it('surfaces the declared name on the composed RouteDescription', async () => {
      @Controller('/users')
      class UsersController {
        @Get('', { name: 'users.index' })
        index() {
          return [];
        }

        @Get(':id', { name: 'users.show' })
        show(@Param('id') id: string) {
          return { id };
        }

        @Get('legacy')
        legacy() {
          return {};
        }
      }

      @Module({ controllers: [UsersController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const routes = app.describeRoutes();

      const show = routes.find((r) => r.name === 'users.show');
      expect(show).toMatchObject({ method: 'GET', path: '/users/:id', name: 'users.show' });

      const index = routes.find((r) => r.name === 'users.index');
      expect(index?.path).toBe('/users');

      // An un-named route carries no `name` (additive/optional field).
      const legacy = routes.find((r) => r.handler === 'legacy');
      expect(legacy?.name).toBeUndefined();
    });
  });

  describe('UrlGeneratorService.urlFor()', () => {
    let app: Awaited<ReturnType<typeof VelaFactory.create>>;
    let urls: UrlGeneratorService;

    beforeEach(async () => {
      @Controller('/users')
      class UsersController {
        @Get('', { name: 'users.index' })
        index() {
          return [];
        }

        @Get(':id', { name: 'users.show' })
        show(@Param('id') id: string) {
          return { id };
        }
      }

      @Module({ controllers: [UsersController] })
      class AppModule {}

      app = await VelaFactory.create(AppModule);
      urls = app.get(UrlGeneratorService);
    });

    it('fills :param placeholders from the params object', () => {
      expect(urls.urlFor('users.show', { id: '42' })).toBe('/users/42');
    });

    it('routes with no dynamic segments need no params', () => {
      expect(urls.urlFor('users.index')).toBe('/users');
    });

    it('appends params that are not path placeholders as query string', () => {
      expect(urls.urlFor('users.show', { id: '42', tab: 'posts' })).toBe('/users/42?tab=posts');
    });

    it('merges opts.query on top of leftover params', () => {
      expect(urls.urlFor('users.index', undefined, { query: { page: 2, active: true } })).toBe(
        '/users?page=2&active=true',
      );
    });

    it('url-encodes param values', () => {
      expect(urls.urlFor('users.show', { id: 'a b/c' })).toBe('/users/a%20b%2Fc');
    });

    it('throws a descriptive error for a missing required param', () => {
      expect(() => urls.urlFor('users.show', {})).toThrow(/Missing route param "id"/);
    });

    it('throws a descriptive error for an unknown route name', () => {
      expect(() => urls.urlFor('does.not.exist')).toThrow(/No route named "does\.not\.exist"/);
    });
  });

  describe('composition — global prefix + version', () => {
    it('urlFor returns the fully composed path (prefix + version + controller + route)', async () => {
      @Controller({ path: '/posts', version: 1 })
      class PostsController {
        @Get(':slug', { name: 'posts.show' })
        show(@Param('slug') slug: string) {
          return { slug };
        }
      }

      @Module({ controllers: [PostsController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule, { globalPrefix: '/api' });
      const urls = app.get(UrlGeneratorService);

      expect(urls.urlFor('posts.show', { slug: 'hello-world' })).toBe('/api/v1/posts/hello-world');
    });

    it('handles a method-level @Version override in the composed URL', async () => {
      @Controller('/reports')
      class ReportsController {
        @Version(2)
        @Get(':id', { name: 'reports.show' })
        show(@Param('id') id: string) {
          return { id };
        }
      }

      @Module({ controllers: [ReportsController] })
      class AppModule {}

      const app = await VelaFactory.create(AppModule);
      const urls = app.get(UrlGeneratorService);

      expect(urls.urlFor('reports.show', { id: '7' })).toBe('/v2/reports/7');
    });
  });

  describe('OpenAPI operationId derives from route name', () => {
    it('defaults operationId to the route name, and an explicit operationId still wins', () => {
      @Controller('/things')
      class ThingsController {
        @Get(':id', { name: 'things.show' })
        show(@Param('id') id: string) {
          return { id };
        }

        @Get('special', { name: 'things.special' })
        @ApiDoc({ operationId: 'explicitlyNamedOp' })
        special() {
          return {};
        }

        @Get('anon')
        anon() {
          return {};
        }
      }

      @Module({ controllers: [ThingsController] })
      class AppModule {}

      const doc = createOpenApiDocument(AppModule, {
        info: { title: 'test', version: '0.0.0' },
      });

      expect(doc.paths['/things/{id}']?.get?.operationId).toBe('things.show');
      // Explicit @ApiDoc operationId takes precedence over the route name.
      expect(doc.paths['/things/special']?.get?.operationId).toBe('explicitlyNamedOp');
      // No name + no @ApiDoc → no operationId emitted.
      expect(doc.paths['/things/anon']?.get?.operationId).toBeUndefined();
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Get, Module, MetadataRegistry, createOpenApiDocument } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

@Controller('/things')
class ThingsController {
  @Get()
  list() {
    return [];
  }
}

@Module({ controllers: [ThingsController] })
class AppModule {}

describe('createOpenApiDocument — servers', () => {
  it('emits options.servers verbatim, positioned between info and paths', () => {
    const servers = [
      { url: 'https://api.example.com', description: 'Prod' },
      { url: 'http://localhost:8787', description: 'Local dev' },
    ];

    const doc = createOpenApiDocument(AppModule, { servers });

    expect(doc.servers).toEqual(servers);
    // Key order: openapi, info, servers, paths, ...
    const keys = Object.keys(doc);
    expect(keys.indexOf('servers')).toBeGreaterThan(keys.indexOf('info'));
    expect(keys.indexOf('servers')).toBeLessThan(keys.indexOf('paths'));
  });

  it('omits the servers key entirely when none passed', () => {
    const doc = createOpenApiDocument(AppModule);
    expect(doc.servers).toBeUndefined();
    expect('servers' in doc).toBe(false);
  });

  it('omits the servers key when an empty array is passed', () => {
    const doc = createOpenApiDocument(AppModule, { servers: [] });
    expect('servers' in doc).toBe(false);
  });
});

describe('createOpenApiDocument — securitySchemes / security', () => {
  it('emits options.securitySchemes under components.securitySchemes', () => {
    const doc = createOpenApiDocument(AppModule, {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session', description: 'Session cookie' },
      },
    });

    expect(doc.components?.securitySchemes).toEqual({
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session', description: 'Session cookie' },
    });
  });

  it('emits document-level security when passed', () => {
    const doc = createOpenApiDocument(AppModule, {
      securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' } },
      security: [{ cookieAuth: [] }],
    });

    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });

  it('omits security key when none / empty passed', () => {
    const none = createOpenApiDocument(AppModule);
    expect('security' in none).toBe(false);

    const empty = createOpenApiDocument(AppModule, { security: [] });
    expect('security' in empty).toBe(false);
  });

  it('omits the components key entirely when neither schemas nor securitySchemes present', () => {
    const doc = createOpenApiDocument(AppModule);
    expect(doc.components).toBeUndefined();
    expect('components' in doc).toBe(false);
  });
});

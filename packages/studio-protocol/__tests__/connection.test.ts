import { describe, expect, it } from 'vitest';
import {
  STUDIO_PROTOCOL_VERSION,
  parseStudioConnection,
  parseTryItRequest,
  parseTryItResponse,
} from '../src';

describe('Studio connection boundary', () => {
  // Version 4 names a module's visibility flag `global` in app.modules (was `isGlobal`).
  it('speaks protocol version 4', () => {
    expect(STUDIO_PROTOCOL_VERSION).toBe(4);
  });
  it('rejects incompatible or malformed bootstrap values', () => {
    for (const value of [
      null,
      {},
      { protocolVersion: 1 },
      {
        protocolVersion: 3,
        routerBasePath: '/studio',
        adminBasePath: '/custom',
        apiRequestPath: '/custom/api-request',
        sessionToken: 'session',
      },
      { protocolVersion: STUDIO_PROTOCOL_VERSION, sessionToken: '' },
    ]) {
      expect(() => parseStudioConnection(value)).toThrow();
    }
  });
  it('validates a complete connection', () => {
    const connection = {
      protocolVersion: STUDIO_PROTOCOL_VERSION,
      routerBasePath: '/studio',
      adminBasePath: '/custom',
      apiRequestPath: '/custom/api-request',
      sessionToken: 'session',
    };
    expect(parseStudioConnection(connection)).toEqual(connection);
    expect(() =>
      parseStudioConnection({ ...connection, adminBasePath: '//evil.example' }),
    ).toThrow();
  });
  it('requires resolved same-origin paths and string headers', () => {
    for (const path of [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      '/users/{id}',
      '/a#b',
    ]) {
      expect(() => parseTryItRequest({ method: 'GET', path })).toThrow();
    }
    expect(() =>
      parseTryItRequest({ method: 'GET', path: '/', headers: { authorization: 123 } }),
    ).toThrow();
    expect(parseTryItRequest({ method: 'patch', path: '/users/a%2Fb' }).method).toBe('PATCH');
  });
  it('validates captured responses', () => {
    expect(parseTryItResponse({ status: 201, headers: {}, body: null }).status).toBe(201);
    for (const value of [
      { status: 0, headers: {}, body: null },
      { status: 200, headers: { x: 1 }, body: '' },
      {},
    ]) {
      expect(() => parseTryItResponse(value)).toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { rpcAdapter } from '../server';

describe('RPC route configuration', () => {
  it.each(['/rpc', '/v1/rpc', '/A_Z-09/rpc_2', '/-', '/_', '/0'])('accepts %j', (path) => {
    expect(rpcAdapter({ path, authorize: 'public' }).name).toBe('rpc');
  });

  it.each([
    '',
    '/',
    'rpc',
    '//rpc',
    '/rpc/',
    '/v1//rpc',
    '/rpc?',
    '/rpc#hash',
    '/rpc.json',
    '/:rpc',
    '/rpc/*',
    '/rpc%2Fcall',
    '/rpc\\call',
    '/rpc call',
    '/café',
    '/rpc\n',
    '/rpc\r\n',
    '/rpc\u0000',
  ])('rejects %j', (path) => {
    expect(() => rpcAdapter({ path, authorize: 'public' })).toThrow(
      'RPC path must be a concrete absolute path without a trailing slash',
    );
  });

  it('accepts a long valid segment and rejects an invalid terminal character', () => {
    const path = `/${'-'.repeat(100_000)}`;
    expect(rpcAdapter({ path, authorize: 'public' }).name).toBe('rpc');
    expect(() => rpcAdapter({ path: `${path}!`, authorize: 'public' })).toThrow('RPC path');
  });

  it('rejects invalid characters and separators after many valid segments', () => {
    const path = `${'/rpc'.repeat(20_000)}/call`;
    expect(rpcAdapter({ path, authorize: 'public' }).name).toBe('rpc');
    expect(() => rpcAdapter({ path: `${path}?`, authorize: 'public' })).toThrow('RPC path');
    expect(() => rpcAdapter({ path: `${path}//call`, authorize: 'public' })).toThrow('RPC path');
    expect(() => rpcAdapter({ path: `${path}/`, authorize: 'public' })).toThrow('RPC path');
  });
});

import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from '../security/secret';
import { SignedInvocationGuard } from '../dispatch/signed-invocation.guard';
import { SignedUrlGuard } from '../http/url/signed-url.guard';

describe('secret representation', () => {
  it('reveals explicitly and redacts common inspection paths', () => {
    const secret = new Secret('sensitive-value');
    expect(secret.reveal()).toBe('sensitive-value');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[Redacted]"}');
    expect(String(secret)).toBe('[Redacted]');
    expect(inspect(secret)).toBe('[Redacted]');
    expect({ ...secret }).toEqual({});
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(secret, Symbol.for('vela.secret'))).toEqual({
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(new Secret(false).reveal()).toBe(false);
    expect(new Secret(0).reveal()).toBe(0);
  });

  it('keeps injected signing secrets and environment bags out of guard properties', () => {
    const env = { URL_SIGNING_SECRET: 'environment-secret' };
    const guards = [
      new SignedUrlGuard('url-secret', env),
      new SignedInvocationGuard('invocation-secret', 'url-secret', undefined, env),
    ];
    for (const guard of guards) {
      const inspection = JSON.stringify(guard) + inspect(guard, { showHidden: true });
      for (const secret of ['environment-secret', 'invocation-secret', 'url-secret'])
        expect(inspection).not.toContain(secret);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer, genericOidcIssuer } from '../issuer';
import { readToken } from '../read-token';
import { requestWithCookie, requestWithHeader } from './harness';

const cfPreset = cloudflareAccessIssuer('acme');

describe('readToken', () => {
  it('reads the assertion header when present', () => {
    const request = requestWithHeader(cfPreset.header, 'jwt-abc');
    expect(readToken(request, cfPreset)).toBe('jwt-abc');
  });

  it('falls back to the cookie when the header is absent', () => {
    const request = requestWithCookie('CF_Authorization', 'jwt-cookie');
    expect(readToken(request, cfPreset)).toBe('jwt-cookie');
  });

  it('reads the correct cookie among several', () => {
    const request = new Request('https://app.example.com/', {
      headers: { cookie: 'a=1; CF_Authorization=jwt-xyz; b=2' },
    });
    expect(readToken(request, cfPreset)).toBe('jwt-xyz');
  });

  it('returns undefined when neither header nor cookie is present', () => {
    expect(readToken(new Request('https://app.example.com/'), cfPreset)).toBeUndefined();
  });

  it('strips a Bearer scheme for a generic OIDC preset', () => {
    const preset = genericOidcIssuer({ issuer: 'https://id.example.com' });
    const request = requestWithHeader('authorization', 'Bearer  jwt-bearer');
    expect(readToken(request, preset)).toBe('jwt-bearer');
    // Case-insensitive scheme.
    expect(readToken(requestWithHeader('authorization', 'bearer jwt-2'), preset)).toBe('jwt-2');
  });

  it('does not consult a cookie when the preset declares none', () => {
    const preset = genericOidcIssuer({ issuer: 'https://id.example.com' });
    const request = requestWithCookie('id_token', 'jwt-cookie');
    expect(readToken(request, preset)).toBeUndefined();
  });

  it('treats an empty header value as absent', () => {
    const request = requestWithHeader(cfPreset.header, '');
    expect(readToken(request, cfPreset)).toBeUndefined();
  });
});

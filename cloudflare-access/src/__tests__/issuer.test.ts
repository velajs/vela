import { describe, expect, it } from 'vitest';
import { cloudflareAccessIssuer, genericOidcIssuer } from '../issuer';

describe('cloudflareAccessIssuer', () => {
  it('expands a bare team name to the canonical issuer + certs JWKS', () => {
    const preset = cloudflareAccessIssuer('acme');
    expect(preset.issuer).toBe('https://acme.cloudflareaccess.com');
    expect(preset.jwksUri).toBe('https://acme.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(preset.algorithms).toEqual(['RS256']);
    expect(preset.header).toBe('cf-access-jwt-assertion');
    expect(preset.cookie).toBe('CF_Authorization');
  });

  it('normalizes a host, a full URL, a trailing slash, and uppercase to one canonical issuer', () => {
    const expected = 'https://acme.cloudflareaccess.com';
    expect(cloudflareAccessIssuer('acme.cloudflareaccess.com').issuer).toBe(expected);
    expect(cloudflareAccessIssuer('https://acme.cloudflareaccess.com').issuer).toBe(expected);
    expect(cloudflareAccessIssuer('https://acme.cloudflareaccess.com/').issuer).toBe(expected);
    expect(cloudflareAccessIssuer('HTTPS://ACME.CloudflareAccess.com/').issuer).toBe(expected);
    // A stray path is dropped, never folded into the issuer.
    expect(cloudflareAccessIssuer('https://acme.cloudflareaccess.com/team/x').issuer).toBe(
      expected,
    );
  });

  it('throws on an empty team domain', () => {
    expect(() => cloudflareAccessIssuer('')).toThrow(/teamDomain is required/);
    expect(() => cloudflareAccessIssuer('   ')).toThrow(/teamDomain is required/);
  });
});

describe('genericOidcIssuer', () => {
  it('defaults the JWKS path to /.well-known/jwks.json and RS256 with a Bearer read', () => {
    const preset = genericOidcIssuer({ issuer: 'https://id.example.com' });
    expect(preset.issuer).toBe('https://id.example.com');
    expect(preset.jwksUri).toBe('https://id.example.com/.well-known/jwks.json');
    expect(preset.algorithms).toEqual(['RS256']);
    expect(preset.header).toBe('authorization');
    expect(preset.bearer).toBe(true);
    expect(preset.cookie).toBeUndefined();
  });

  it('honors explicit jwksUri, algorithms, header, cookie and trims a trailing slash', () => {
    const preset = genericOidcIssuer({
      issuer: 'https://id.example.com/',
      jwksUri: 'https://keys.example.com/jwks',
      algorithms: ['RS256', 'RS384'],
      header: 'x-id-token',
      cookie: 'id_token',
    });
    expect(preset.issuer).toBe('https://id.example.com');
    expect(preset.jwksUri).toBe('https://keys.example.com/jwks');
    expect(preset.algorithms).toEqual(['RS256', 'RS384']);
    expect(preset.header).toBe('x-id-token');
    // A custom header defaults to a raw token unless bearer is explicitly set.
    expect(preset.bearer).toBe(false);
    expect(preset.cookie).toBe('id_token');
  });

  it('throws on an empty issuer', () => {
    expect(() => genericOidcIssuer({ issuer: '' })).toThrow(/non-empty issuer/);
  });
});

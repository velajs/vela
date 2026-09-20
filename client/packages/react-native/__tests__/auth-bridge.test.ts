import { describe, expect, it } from 'vitest';
// Import ONLY the peer-free bearer module (never `../src/auth`, which pulls the
// optional `@better-auth/expo` peer) so the token readers unit-test without any
// Expo native shim.
import { expoAuthToken, expoBearerToken } from '../src/bearer';
import { createNativeClient } from '../src/create-native-client';
import { makeFetch } from './harness';

const authClient = (cookie: string): { getCookie: () => string } => ({ getCookie: () => cookie });

describe('expoBearerToken', () => {
  it('extracts the better-auth session token from a cookie string', () => {
    const token: string | null = expoBearerToken(
      authClient('a=1; better-auth.session_token=abc123; b=2'),
    );
    expect(token).toBe('abc123');
  });

  it('extracts a __Secure- prefixed session token', () => {
    expect(expoBearerToken(authClient('__Secure-better-auth.session_token=secure-tok'))).toBe(
      'secure-tok',
    );
  });

  it('extracts a bare session_token cookie', () => {
    expect(expoBearerToken(authClient('session_token=bare'))).toBe('bare');
  });

  it('returns null when signed out (empty cookie, no match, or empty value)', () => {
    expect(expoBearerToken(authClient(''))).toBeNull();
    expect(expoBearerToken(authClient('a=1; b=2'))).toBeNull();
    expect(expoBearerToken(authClient('better-auth.session_token='))).toBeNull();
  });
});

describe('expoAuthToken', () => {
  it('returns an authToken provider yielding string | undefined', () => {
    const provider: () => string | undefined = expoAuthToken(
      authClient('better-auth.session_token=tok'),
    );
    const value: string | undefined = provider();
    expect(value).toBe('tok');
    expect(expoAuthToken(authClient(''))()).toBeUndefined();
  });

  it('feeds the bearer into the native client HTTP mutation', async () => {
    const { fetch, calls } = makeFetch();
    const client = createNativeClient({
      queries: {},
      url: 'http://api.test',
      authToken: expoAuthToken(authClient('better-auth.session_token=xyz789')),
      fetch,
    });

    await client.mutate('/todos', { text: 'hi' });

    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer xyz789');
    client.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  csrfRejectionReason,
  hostnameOf,
  isLoopbackAddress,
  transportRejectionReason,
} from '../src/gates';

const headers = (init: Record<string, string>): Headers => new Headers(init);

describe('isLoopbackAddress', () => {
  it('accepts loopback v4/v6 and the IPv4-mapped form', () => {
    for (const addr of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(addr)).toBe(true);
    }
  });
  it('treats a missing address as loopback (in-process transport)', () => {
    expect(isLoopbackAddress(undefined)).toBe(true);
    expect(isLoopbackAddress('')).toBe(true);
  });
  it('rejects public addresses', () => {
    for (const addr of ['10.0.0.5', '192.168.1.9', '8.8.8.8', '::ffff:8.8.8.8']) {
      expect(isLoopbackAddress(addr)).toBe(false);
    }
  });
});

describe('hostnameOf', () => {
  it('strips port and IPv6 brackets', () => {
    expect(hostnameOf('localhost:5173')).toBe('localhost');
    expect(hostnameOf('[::1]:8787')).toBe('::1');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('transportRejectionReason', () => {
  it('passes a loopback peer with a localhost Host', () => {
    expect(
      transportRejectionReason({
        remoteAddress: '127.0.0.1',
        headers: headers({ host: 'localhost:1' }),
      }),
    ).toBeUndefined();
  });
  it('rejects a non-loopback peer', () => {
    expect(transportRejectionReason({ remoteAddress: '10.0.0.5', headers: headers({}) })).toMatch(
      /loopback/,
    );
  });
  it('rejects a non-localhost Host header (DNS rebind)', () => {
    expect(
      transportRejectionReason({
        remoteAddress: '127.0.0.1',
        headers: headers({ host: 'evil.example.com' }),
      }),
    ).toMatch(/Host/);
  });
  it('rejects any X-Forwarded-* / Forwarded header', () => {
    for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) {
      expect(
        transportRejectionReason({
          remoteAddress: '127.0.0.1',
          headers: headers({ host: 'localhost', [name]: 'x' }),
        }),
      ).toMatch(/X-Forwarded/);
    }
  });
});

describe('csrfRejectionReason', () => {
  it('accepts same-origin Sec-Fetch-Site with JSON content-type', () => {
    expect(
      csrfRejectionReason({
        method: 'POST',
        headers: headers({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
      }),
    ).toBeUndefined();
  });
  it('rejects a cross-site Sec-Fetch-Site', () => {
    expect(
      csrfRejectionReason({ method: 'POST', headers: headers({ 'sec-fetch-site': 'cross-site' }) }),
    ).toMatch(/cross-origin/);
  });
  it('rejects a mismatched Origin when Sec-Fetch-Site is absent', () => {
    expect(
      csrfRejectionReason({
        method: 'POST',
        headers: headers({
          origin: 'http://evil.test',
          host: 'localhost:5173',
          'content-type': 'application/json',
        }),
      }),
    ).toMatch(/cross-origin/);
  });
  it('rejects a non-JSON content-type on a state-changing method', () => {
    expect(
      csrfRejectionReason({
        method: 'POST',
        headers: headers({ 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }),
      }),
    ).toMatch(/content-type/);
  });
  it('does not require JSON on safe methods (GET/HEAD)', () => {
    expect(
      csrfRejectionReason({ method: 'GET', headers: headers({ 'sec-fetch-site': 'same-origin' }) }),
    ).toBeUndefined();
  });
});

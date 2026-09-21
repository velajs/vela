import { describe, expect, it } from 'vitest';
import {
  assertSafeHeaderName,
  assertSafeHeaderValue,
  assertSafeSubject,
  MAX_HEADER_VALUE_LENGTH,
  MAX_SUBJECT_LENGTH,
  parseAddress,
  parseAddressList,
} from '../address';
import { MailError } from '../mail.error';
import { ADDRESS_VECTORS, CONTROL_VECTORS } from './vectors';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MailError) return err.code;
    throw err;
  }
  throw new Error('expected a MailError to be thrown');
}

describe('parseAddress', () => {
  it('accepts a bare address', () => {
    expect(parseAddress('alice@example.com')).toEqual({ email: 'alice@example.com' });
  });

  it('accepts a bracketed display form and trims captures', () => {
    expect(parseAddress('  Alice A  <  alice@example.com  >')).toEqual({
      email: 'alice@example.com',
      name: 'Alice A',
    });
  });

  it('accepts an { email, name } object and trims', () => {
    expect(parseAddress({ email: ' alice@example.com ', name: ' Alice ' })).toEqual({
      email: 'alice@example.com',
      name: 'Alice',
    });
  });

  it('drops an empty display name', () => {
    expect(parseAddress('   <alice@example.com>')).toEqual({ email: 'alice@example.com' });
    expect(parseAddress({ email: 'alice@example.com', name: '   ' })).toEqual({
      email: 'alice@example.com',
    });
  });

  it('rejects a structurally invalid email', () => {
    expect(code(() => parseAddress('not-an-email'))).toBe('invalid_address');
    expect(code(() => parseAddress('a@@b.com'))).toBe('invalid_address');
    expect(code(() => parseAddress('@b.com'))).toBe('invalid_address');
    expect(code(() => parseAddress('a@'))).toBe('invalid_address');
  });

  it('rejects an email longer than 320 characters', () => {
    const long = `${'a'.repeat(320)}@example.com`;
    expect(code(() => parseAddress(long))).toBe('invalid_address');
  });

  it('rejects a display name longer than 256 characters', () => {
    expect(code(() => parseAddress({ email: 'a@b.com', name: 'n'.repeat(257) }))).toBe(
      'invalid_address',
    );
  });

  it.each(ADDRESS_VECTORS)('rejects $label in the email', ({ char }) => {
    expect(code(() => parseAddress({ email: `bad${char}@example.com` }))).toBe('invalid_address');
  });

  it.each(ADDRESS_VECTORS)('rejects $label in the display name', ({ char }) => {
    expect(code(() => parseAddress({ email: 'a@b.com', name: `Bad${char}Name` }))).toBe(
      'invalid_address',
    );
  });

  it('rejects an angle bracket smuggled into the email', () => {
    expect(code(() => parseAddress({ email: 'a@b.com>' }))).toBe('invalid_address');
    expect(code(() => parseAddress({ email: '<a@b.com' }))).toBe('invalid_address');
  });
});

describe('parseAddressList', () => {
  it('wraps a single address into a one-element list', () => {
    expect(parseAddressList('a@b.com')).toEqual([{ email: 'a@b.com' }]);
  });

  it('parses each element of a list', () => {
    expect(parseAddressList(['a@b.com', { email: 'c@d.com', name: 'C' }])).toEqual([
      { email: 'a@b.com' },
      { email: 'c@d.com', name: 'C' },
    ]);
  });

  it('rejects the whole list when any element is poisoned', () => {
    expect(code(() => parseAddressList(['a@b.com', 'bad,@b.com']))).toBe('invalid_address');
  });
});

describe('assertSafeHeaderName', () => {
  it('accepts an RFC 5322 field name', () => {
    expect(() => assertSafeHeaderName('X-Custom-Header')).not.toThrow();
  });

  it('rejects an empty name', () => {
    expect(code(() => assertSafeHeaderName(''))).toBe('invalid_header');
  });

  it('rejects a colon, a space, and control characters in the name', () => {
    expect(code(() => assertSafeHeaderName('X:Evil'))).toBe('invalid_header');
    expect(code(() => assertSafeHeaderName('X Evil'))).toBe('invalid_header');
    for (const { char } of CONTROL_VECTORS) {
      expect(code(() => assertSafeHeaderName(`X-${char}`))).toBe('invalid_header');
    }
  });
});

describe('assertSafeHeaderValue', () => {
  it('allows a comma in a header value', () => {
    expect(() => assertSafeHeaderValue('x', 'a, b, c')).not.toThrow();
  });

  it.each(CONTROL_VECTORS)('rejects $label in a header value', ({ char }) => {
    expect(code(() => assertSafeHeaderValue('x', `a${char}b`))).toBe('invalid_header');
  });

  it('rejects a value beyond the length ceiling', () => {
    expect(code(() => assertSafeHeaderValue('x', 'a'.repeat(MAX_HEADER_VALUE_LENGTH + 1)))).toBe(
      'invalid_header',
    );
    expect(() => assertSafeHeaderValue('x', 'a'.repeat(MAX_HEADER_VALUE_LENGTH))).not.toThrow();
  });
});

describe('assertSafeSubject', () => {
  it('accepts a normal subject', () => {
    expect(() => assertSafeSubject('Hello there')).not.toThrow();
  });

  it('caps the subject at 998 characters', () => {
    expect(() => assertSafeSubject('a'.repeat(MAX_SUBJECT_LENGTH))).not.toThrow();
    expect(code(() => assertSafeSubject('a'.repeat(MAX_SUBJECT_LENGTH + 1)))).toBe(
      'invalid_header',
    );
  });

  it.each(CONTROL_VECTORS)('rejects $label in the subject', ({ char }) => {
    expect(code(() => assertSafeSubject(`Hi${char}there`))).toBe('invalid_header');
  });
});

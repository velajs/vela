import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { resolveStructuredError, statusForCode, INTERNAL_ERROR_MESSAGE } from '../mappers';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  InputValidationException,
} from '../errors';
import type { ErrorMapper } from '../envelope';

describe('statusForCode', () => {
  it('maps known codes to their canonical HTTP status', () => {
    expect(statusForCode('VALIDATION_ERROR')).toBe(400);
    expect(statusForCode('AGGREGATION_ERROR')).toBe(400);
    expect(statusForCode('TENANT_REQUIRED')).toBe(400);
    expect(statusForCode('UNAUTHORIZED')).toBe(401);
    expect(statusForCode('FORBIDDEN')).toBe(403);
    expect(statusForCode('NOT_FOUND')).toBe(404);
    expect(statusForCode('CONFLICT')).toBe(409);
    expect(statusForCode('CONFIGURATION_ERROR')).toBe(500);
    expect(statusForCode('CACHE_ERROR')).toBe(500);
    expect(statusForCode('INTERNAL_ERROR')).toBe(500);
  });

  it('falls back to 500 for unknown/custom codes', () => {
    expect(statusForCode('RATE_LIMIT_EXCEEDED')).toBe(500);
  });
});

describe('resolveStructuredError precedence', () => {
  it('(a) custom mappers run first and the first non-undefined wins', () => {
    const first: ErrorMapper = () => undefined;
    const second: ErrorMapper = (e) =>
      (e as Error).message === 'dup' ? { code: 'CONFLICT', message: 'Already exists' } : undefined;
    const third: ErrorMapper = () => ({ code: 'INTERNAL_ERROR', message: 'unreached' });

    const { structured, status } = resolveStructuredError(new Error('dup'), [first, second, third]);
    expect(structured).toEqual({ code: 'CONFLICT', message: 'Already exists' });
    expect(status).toBe(409); // status derives from statusForCode(code)
  });

  it('(a) a custom mapper overrides even a CrudException', () => {
    const mapper: ErrorMapper = () => ({ code: 'FORBIDDEN', message: 'nope' });
    const { structured, status } = resolveStructuredError(new NotFoundException('Post', 'p1'), [
      mapper,
    ]);
    expect(structured.code).toBe('FORBIDDEN');
    expect(status).toBe(403);
  });

  it('(a) a throwing mapper is skipped, not fatal', () => {
    const throwing: ErrorMapper = () => {
      throw new Error('mapper blew up');
    };
    const good: ErrorMapper = () => ({ code: 'CONFLICT', message: 'ok' });
    const { structured } = resolveStructuredError(new Error('x'), [throwing, good]);
    expect(structured.code).toBe('CONFLICT');
  });

  it('(b) a CrudException uses its own structured payload and statusCode', () => {
    const { structured, status } = resolveStructuredError(
      new ConflictException('Dup key', { field: 'email' }),
    );
    expect(status).toBe(409);
    expect(structured).toEqual({
      code: 'CONFLICT',
      message: 'Dup key',
      details: { field: 'email' },
    });
  });

  it('(b) covers CrudException subclasses like Forbidden', () => {
    const { structured, status } = resolveStructuredError(new ForbiddenException());
    expect(status).toBe(403);
    expect(structured.code).toBe('FORBIDDEN');
  });

  it('(b) a Zod-derived InputValidationException is handled as a CrudException, keeping its issues', () => {
    const parsed = z.object({ age: z.number() }).safeParse({ age: 'x' });
    const ex = InputValidationException.fromZodError(parsed.error!);
    const { structured, status } = resolveStructuredError(ex);
    expect(status).toBe(400);
    expect(structured.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(structured.details)).toBe(true);
  });

  it('(c) a raw Zod error is flattened to VALIDATION_ERROR 400 with issue details', () => {
    const parsed = z.object({ name: z.string(), age: z.number() }).safeParse({ age: 'x' });
    const { structured, status } = resolveStructuredError(parsed.error);
    expect(status).toBe(400);
    expect(structured.code).toBe('VALIDATION_ERROR');
    expect(structured.message).toBe('Validation failed');
    const details = structured.details as Array<{ path: string; message: string; code: string }>;
    expect(details.length).toBeGreaterThan(0);
    expect(details.every((d) => typeof d.path === 'string' && typeof d.code === 'string')).toBe(
      true,
    );
  });

  it('(c) any object with an issues array is treated as Zod-shaped', () => {
    const fake = { issues: [{ path: ['a', 'b'], message: 'bad', code: 'custom' }] };
    const { structured, status } = resolveStructuredError(fake);
    expect(status).toBe(400);
    expect(structured.code).toBe('VALIDATION_ERROR');
    expect((structured.details as Array<{ path: string }>)[0].path).toBe('a.b');
  });

  it('(d) an arbitrary error is masked as INTERNAL_ERROR 500 and never leaks the message', () => {
    const { structured, status } = resolveStructuredError(
      new Error('SELECT * FROM secrets WHERE token = "sk-live-123"'),
    );
    expect(status).toBe(500);
    expect(structured.code).toBe('INTERNAL_ERROR');
    expect(structured.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(structured.message).not.toContain('secrets');
    expect(structured.message).not.toContain('sk-live-123');
  });

  it('(d) non-Error thrown values (strings, null) also mask to a generic 500', () => {
    expect(resolveStructuredError('kaboom').structured.code).toBe('INTERNAL_ERROR');
    expect(resolveStructuredError('kaboom').status).toBe(500);
    expect(resolveStructuredError(null).structured.message).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('falls through to built-ins when custom mappers all return undefined', () => {
    const noop: ErrorMapper = () => undefined;
    const { structured, status } = resolveStructuredError(new NotFoundException('Post'), [noop]);
    expect(structured.code).toBe('NOT_FOUND');
    expect(status).toBe(404);
  });
});

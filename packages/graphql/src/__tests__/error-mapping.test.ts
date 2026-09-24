import {
  HttpException,
  NotFoundException,
  TooManyRequestsException,
  VelaError,
  type HttpErrorResponse,
} from '@velajs/vela';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { mapGraphqlError } from '../errors';

const field = (originalError: Error) =>
  mapGraphqlError(new GraphQLError(originalError.message, { originalError, path: ['field'] }));

describe('GraphQL error mapping', () => {
  it('derives the public code from the shared HTTP renderer status', () => {
    expect(field(new VelaError('forbidden', { message: 'secret policy' })).toJSON()).toEqual({
      message: 'Access denied',
      path: ['field'],
      extensions: { code: 'FORBIDDEN' },
    });
    expect(field(new NotFoundException('row 7 in tenant x')).extensions).toEqual({
      code: 'NOT_FOUND',
    });
    expect(field(new TooManyRequestsException()).extensions).toEqual({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('uses an exception-owned response status without its body', () => {
    class LockedRow extends HttpException {
      constructor() {
        super('internal id 7', 409);
      }
      override toResponse(): HttpErrorResponse {
        return { status: 404, body: { row: 'internal id 7' } };
      }
    }
    const mapped = field(new LockedRow());
    expect(mapped.message).toBe('Not found');
    expect(mapped.extensions).toEqual({ code: 'NOT_FOUND' });
  });

  it('masks a foreign error that defines its own toResponse()', () => {
    class ForeignRow extends Error {
      toResponse(): HttpErrorResponse {
        return { status: 404, body: { row: 'internal id 7' } };
      }
    }
    const mapped = field(new ForeignRow('internal id 7'));
    expect(mapped.message).toBe('Unexpected error');
    expect(mapped.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('keeps unknown errors masked', () => {
    const mapped = field(new Error('db password=secret'));
    expect(mapped.message).toBe('Unexpected error');
    expect(mapped.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

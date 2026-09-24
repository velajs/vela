import { renderHttpError } from '@velajs/vela';
import { SchemaValidationError } from '@velajs/vela/validation';
import { GraphQLError } from 'graphql';

export type GraphqlErrorCode =
  | 'BAD_USER_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOO_MANY_REQUESTS';

/** Explicit, bounded client-facing errors. Arbitrary resolver errors remain masked. */
export class GraphqlClientError extends Error {
  readonly code: GraphqlErrorCode;
  constructor(code: GraphqlErrorCode, message: string) {
    super(message.slice(0, 512));
    if (
      ![
        'BAD_USER_INPUT',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'NOT_FOUND',
        'TOO_MANY_REQUESTS',
      ].includes(code)
    ) {
      throw new TypeError('Unknown public GraphQL error code');
    }
    this.code = code;
    this.name = 'GraphqlClientError';
  }
}

export function mapGraphqlError(error: GraphQLError): GraphQLError {
  const original = error.originalError;
  let code: string = 'INTERNAL_SERVER_ERROR';
  let message = 'Unexpected error';
  if (original instanceof GraphqlClientError) {
    code = original.code;
    message = original.message;
  } else if (original instanceof SchemaValidationError) {
    code = 'BAD_USER_INPUT';
    message = 'Invalid arguments';
  } else if (original) {
    // The status every HTTP edge would answer with; the public message stays fixed.
    const { status } = renderHttpError(original, { redactServerBodies: true });
    const publicErrors: Record<number, readonly [string, string]> = {
      400: ['BAD_USER_INPUT', 'Invalid arguments'],
      401: ['UNAUTHENTICATED', 'Authentication required'],
      403: ['FORBIDDEN', 'Access denied'],
      404: ['NOT_FOUND', 'Not found'],
      429: ['TOO_MANY_REQUESTS', 'Too many requests'],
    };
    [code, message] = publicErrors[status] ?? [code, message];
  } else if (!original && !error.path) {
    // Parser/validation diagnostics: never forward arbitrary extensions/stack traces.
    code = 'GRAPHQL_VALIDATION_FAILED';
    message = error.message.slice(0, 512);
  }
  return new GraphQLError(message, {
    ...(error.path ? { path: error.path } : {}),
    extensions: { code },
  });
}

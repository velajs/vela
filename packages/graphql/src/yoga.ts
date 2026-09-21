import { mapSchema, MapperKind } from '@graphql-tools/utils';
import {
  defaultFieldResolver,
  GraphQLError,
  NoSchemaIntrospectionCustomRule,
  parse,
  type GraphQLSchema,
  type SelectionSetNode,
  type ValidationRule,
} from 'graphql';
import { createYoga, type Plugin } from 'graphql-yoga';
import { mapGraphqlError } from './errors';
import { GraphqlOperation } from './operation';
import type { GraphqlContext, GraphqlDriver } from './types';

export interface YogaDriverOptions {
  readonly introspection?: boolean;
  /** Defaults to 64 KiB; also enforced for streaming bodies without Content-Length. */
  readonly maxRequestBytes?: number;
  readonly maxDocumentTokens?: number;
  readonly maxDepth?: number;
  readonly maxFields?: number;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new TypeError(`${name} must be a positive integer`);
  return result;
}

/** Opt-in server dependency; accepts only one bounded JSON query/mutation per POST. */
export function yogaDriver(options: YogaDriverOptions = {}): GraphqlDriver {
  const maxRequestBytes = positive(options.maxRequestBytes, 65_536, 'maxRequestBytes');
  const maxTokens = positive(options.maxDocumentTokens, 5_000, 'maxDocumentTokens');
  const maxDepth = positive(options.maxDepth, 16, 'maxDepth');
  const maxFields = positive(options.maxFields, 200, 'maxFields');
  return {
    create(schema, path) {
      const plugin: Plugin<GraphqlContext, GraphqlContext> = {
        onParse({ setParseFn }) {
          setParseFn((source, parseOptions) => parse(source, { ...parseOptions, maxTokens }));
        },
        onValidate({ addValidationRule }) {
          addValidationRule(operationLimits(maxDepth, maxFields));
          if (!options.introspection) addValidationRule(NoSchemaIntrospectionCustomRule);
        },
        onExecutionResult({ result, setResult, context }) {
          if (!result || !('errors' in result) || !result.errors) return;
          for (const error of result.errors) {
            if (error.originalError)
              context.operation.report(error.originalError, error.path?.join('.') ?? 'GraphQL');
          }
          setResult({ ...result, errors: result.errors.slice(0, 10).map(mapGraphqlError) });
        },
      };
      const yoga = createYoga<GraphqlContext>({
        fetchAPI: { Request, Response, Headers },
        disposeOnProcessTerminate: false,
        schema: ownedResolvers(schema),
        graphqlEndpoint: path,
        graphiql: false,
        landingPage: false,
        logging: false,
        cors: false,
        batching: false,
        multipart: false,
        maskedErrors: false,
        maxRequestBodySize: maxRequestBytes,
        plugins: [plugin],
      });
      return {
        dispose: () => yoga.dispose(),
        async handle(request, context) {
          if (request.method !== 'POST')
            return failure(405, 'Only POST is supported', { Allow: 'POST' });
          if (
            request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
            'application/json'
          ) {
            return failure(415, 'Content-Type must be application/json');
          }
          return yoga.fetch(request, context);
        },
      };
    },
  };
}

function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { errors: [{ message, extensions: { code: 'BAD_REQUEST' } }] },
    { status, headers },
  );
}

function ownedResolvers(schema: GraphQLSchema): GraphQLSchema {
  // Clone schema fields; never mutate an executable schema shared by two applications.
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (field) => {
      const resolve = field.resolve ?? defaultFieldResolver;
      return {
        ...field,
        resolve(root: unknown, args: Record<string, unknown>, context: GraphqlContext, info) {
          if (!(context.operation instanceof GraphqlOperation))
            throw new Error('Missing GraphQL operation');
          const operation = context.operation;
          return operation.track(async () => {
            const result: unknown = await resolve(root, args, context, info);
            operation.assertActive();
            return result;
          });
        },
      };
    },
  });
}

function operationLimits(maxDepth: number, maxFields: number): ValidationRule {
  return (context) => {
    let operations = 0;
    return {
      Directive(node) {
        if (node.name.value === 'defer' || node.name.value === 'stream') {
          context.reportError(
            new GraphQLError('Incremental execution is not supported', { nodes: node }),
          );
        }
      },
      OperationDefinition(node) {
        if (++operations > 1 || node.operation === 'subscription') {
          context.reportError(
            new GraphQLError('Exactly one query or mutation is supported', { nodes: node }),
          );
          return;
        }
        let fields = 0;
        const active = new Set<string>();
        const walk = (selection: SelectionSetNode, depth: number): boolean => {
          if (depth > maxDepth) return false;
          for (const item of selection.selections) {
            if (item.kind === 'Field') {
              if (++fields > maxFields) return false;
              if (item.selectionSet && !walk(item.selectionSet, depth + 1)) return false;
            } else if (item.kind === 'InlineFragment') {
              if (!walk(item.selectionSet, depth)) return false;
            } else {
              if (active.has(item.name.value)) return false;
              const fragment = context.getFragment(item.name.value);
              if (fragment) {
                active.add(item.name.value);
                if (!walk(fragment.selectionSet, depth)) return false;
                active.delete(item.name.value);
              }
            }
          }
          return true;
        };
        if (!walk(node.selectionSet, 1)) {
          context.reportError(
            new GraphQLError(
              'Operation exceeds the field/depth budget or contains a fragment cycle',
              { nodes: node },
            ),
          );
        }
      },
    };
  };
}

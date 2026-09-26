import type { Type } from '@velajs/vela';
import {
  createDiscoverableDecorator,
  type Container,
  type DiscoveryService,
  MetadataRegistry,
} from '@velajs/vela/module-kit';
import type { ValidationSchema } from '@velajs/vela/validation';
import {
  buildASTSchema,
  buildSchema,
  isObjectType,
  type DocumentNode,
  type GraphQLSchema,
} from 'graphql';
import { bindProviderResolver } from './resolver';
import type { GraphqlResolverContext } from './types';

/** Validators apply to the complete argument object and the returned field value. */
export interface GraphqlFieldOptions {
  readonly args?: ValidationSchema;
  readonly output?: ValidationSchema;
}

interface FieldMetadata extends GraphqlFieldOptions {
  readonly kind: 'query' | 'mutation' | 'field';
  readonly name: string;
}

interface ResolverMetadata {
  readonly typeName?: string;
}

type Parameter =
  | { readonly kind: 'args'; readonly name?: string }
  | { readonly kind: 'parent' | 'context' | 'info' };
interface ParameterMetadata {
  readonly index: number;
  readonly value: Parameter;
}

const resolverMarker = createDiscoverableDecorator<ResolverMetadata>('vela:graphql:resolver');
const fieldMarker = createDiscoverableDecorator<FieldMetadata>('vela:graphql:field');
const PARAMETERS = 'vela:graphql:parameters';

function graphqlName(name: string): string {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(name)) {
    throw new TypeError(`Invalid GraphQL name '${name}'`);
  }
  return name;
}

/** Discover this provider; a type name is required only for ResolveField methods. */
export function Resolver(typeName?: string): ClassDecorator {
  return resolverMarker(typeName === undefined ? {} : { typeName: graphqlName(typeName) });
}

function fieldDecorator(
  kind: FieldMetadata['kind'],
  name: string | undefined,
  options: GraphqlFieldOptions,
): MethodDecorator {
  return (target, methodName, descriptor) => {
    if (typeof target === 'function' || typeof descriptor?.value !== 'function') {
      throw new TypeError('GraphQL field decorators require an instance method');
    }
    const fieldName = name ?? (typeof methodName === 'string' ? methodName : undefined);
    if (fieldName === undefined) throw new TypeError('GraphQL symbol methods need a field name');
    if (MetadataRegistry.getCustomHandlerMeta(target.constructor, methodName, fieldMarker.KEY)) {
      throw new TypeError(`GraphQL method '${String(methodName)}' already has a field decorator`);
    }
    fieldMarker({ ...options, kind, name: graphqlName(fieldName) })(target, methodName, descriptor);
  };
}

export function Query(name?: string, options: GraphqlFieldOptions = {}): MethodDecorator {
  return fieldDecorator('query', name, options);
}

export function Mutation(name?: string, options: GraphqlFieldOptions = {}): MethodDecorator {
  return fieldDecorator('mutation', name, options);
}

export function ResolveField(name?: string, options: GraphqlFieldOptions = {}): MethodDecorator {
  return fieldDecorator('field', name, options);
}

function parameter(value: Parameter): ParameterDecorator {
  return (target, method, index) => {
    if (method === undefined || typeof target === 'function') {
      throw new TypeError('GraphQL parameter decorators require an instance method');
    }
    const entries = parameters(target.constructor, method);
    if (entries.some((entry) => entry.index === index)) {
      throw new TypeError(`GraphQL parameter ${index} of '${String(method)}' is already decorated`);
    }
    MetadataRegistry.setCustomHandlerMeta(target.constructor, method, PARAMETERS, [
      ...entries,
      { index, value },
    ]);
  };
}

/** Read all validated arguments, or one direct property of that object. */
export function Args(name?: string): ParameterDecorator {
  return parameter(
    name === undefined ? { kind: 'args' } : { kind: 'args', name: graphqlName(name) },
  );
}
export function Parent(): ParameterDecorator {
  return parameter({ kind: 'parent' });
}
/** Receive the existing GraphqlResolverContext, including operation, request and signal. */
export function Context(): ParameterDecorator {
  return parameter({ kind: 'context' });
}
export function Info(): ParameterDecorator {
  return parameter({ kind: 'info' });
}

function parameters(provider: object, method: string | symbol): readonly ParameterMetadata[] {
  // This namespaced slot is written only by the parameter decorators above.
  return (
    (MetadataRegistry.getCustomHandlerMeta(provider, method, PARAMETERS) as
      | readonly ParameterMetadata[]
      | undefined) ?? []
  );
}

function mappedArguments(
  entries: readonly ParameterMetadata[],
  args: unknown,
  field: GraphqlResolverContext,
): unknown[] {
  const values: unknown[] = [];
  for (const { index, value } of entries) {
    switch (value.kind) {
      case 'args':
        values[index] =
          value.name === undefined
            ? args
            : typeof args === 'object' && args !== null
              ? Reflect.get(args, value.name)
              : undefined;
        break;
      case 'parent':
        values[index] = field.root;
        break;
      case 'context':
        values[index] = field;
        break;
      case 'info':
        values[index] = field.info;
        break;
    }
  }
  return values;
}

/** Build an endpoint-owned schema without retaining providers or app state in metadata. */
export function decoratedSchema(
  typeDefs: string | DocumentNode,
  discovery: DiscoveryService,
  include: readonly Type[] | undefined,
  container: Container,
): GraphQLSchema {
  const schema = typeof typeDefs === 'string' ? buildSchema(typeDefs) : buildASTSchema(typeDefs);
  const fields = discovery
    .registeredMethodsWithMeta(fieldMarker, { metadataOnly: true })
    .filter(
      (registration) =>
        include === undefined ||
        include.some(
          (module) => container.getModuleScope(registration.class.moduleId)?.moduleClass === module,
        ),
    );
  const assigned = new Set<string>();
  for (const { class: registration, methodName, meta } of fields) {
    const provider = registration.metatype;
    const resolver = MetadataRegistry.getCustomClassMeta(provider, resolverMarker.KEY) as
      | ResolverMetadata
      | undefined;
    if (!resolver) throw new TypeError(`GraphQL provider ${provider.name} needs @Resolver()`);
    const typeName =
      meta.kind === 'query'
        ? schema.getQueryType()?.name
        : meta.kind === 'mutation'
          ? schema.getMutationType()?.name
          : resolver.typeName;
    if (!typeName)
      throw new TypeError(
        `GraphQL ${provider.name}.${String(methodName)} has no ${meta.kind} type`,
      );
    const type = schema.getType(typeName);
    const field = isObjectType(type) ? type.getFields()[meta.name] : undefined;
    if (!field)
      throw new TypeError(`GraphQL field '${typeName}.${meta.name}' is absent from the SDL`);
    const coordinate = `${typeName}.${meta.name}`;
    if (assigned.has(coordinate))
      throw new TypeError(`Duplicate GraphQL resolver for '${coordinate}'`);
    assigned.add(coordinate);
    const entries = parameters(provider, methodName);
    field.resolve = bindProviderResolver(provider, methodName, {
      ...(meta.args === undefined ? {} : { args: meta.args }),
      ...(meta.output === undefined ? {} : { output: meta.output }),
      moduleId: registration.moduleId,
      mapArgs: (args, context) => mappedArguments(entries, args, context),
    });
  }
  return schema;
}

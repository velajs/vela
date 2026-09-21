import type { DiscoveryService, PipelineComponentEntry } from '@velajs/vela';
import type { GraphQLResolveInfo, GraphQLSchema } from 'graphql';
import type { GraphqlOperation } from './operation';

export interface GraphqlContext {
  readonly operation: GraphqlOperation;
}

export interface GraphqlResolverContext extends GraphqlContext {
  readonly root: unknown;
  readonly info: GraphQLResolveInfo;
  readonly request: Request;
  readonly signal: AbortSignal;
}

/** HTTP globals run once at the transport boundary. These run for each bound field. */
export interface GraphqlPipeline {
  readonly guards?: readonly PipelineComponentEntry<'guard'>[];
  readonly pipes?: readonly PipelineComponentEntry<'pipe'>[];
  readonly interceptors?: readonly PipelineComponentEntry<'interceptor'>[];
  readonly filters?: readonly PipelineComponentEntry<'filter'>[];
}

export interface GraphqlSchemaContext {
  readonly discovery: DiscoveryService;
}

export interface GraphqlServer {
  handle(request: Request, context: GraphqlContext): Promise<Response>;
  dispose?(): void | Promise<void>;
}

/** Third-party server dependencies stay behind their explicitly imported driver. */
export interface GraphqlDriver {
  create(schema: GraphQLSchema, path: string): GraphqlServer | Promise<GraphqlServer>;
}

export interface GraphqlOptions extends GraphqlPipeline {
  readonly path?: string;
  readonly schema:
    | GraphQLSchema
    | ((context: GraphqlSchemaContext) => GraphQLSchema | Promise<GraphQLSchema>);
  readonly driver: GraphqlDriver;
}

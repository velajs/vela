import type { DiscoveryService, PipelineComponentEntry } from '@velajs/vela/module-kit';
import type { Type } from '@velajs/vela';
import type { DocumentNode, GraphQLResolveInfo, GraphQLSchema } from 'graphql';
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

interface GraphqlCommonOptions extends GraphqlPipeline {
  readonly path?: string;
  readonly driver: GraphqlDriver;
}

/** Supply an executable schema, or SDL whose fields bind to discovered resolvers. */
export type GraphqlOptions = GraphqlCommonOptions &
  (
    | {
        readonly schema:
          | GraphQLSchema
          | ((context: GraphqlSchemaContext) => GraphQLSchema | Promise<GraphQLSchema>);
        readonly typeDefs?: never;
        readonly include?: never;
      }
    | {
        readonly schema?: never;
        readonly typeDefs: string | DocumentNode;
        /** Declaring modules to discover. Omitted selects the application; [] selects none. */
        readonly include?: readonly Type[];
      }
  );

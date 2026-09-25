import type { Context } from 'hono';
import type { ParamExtractionRoute, RouteInputValues } from './types';

/** Builds the reader that validates a route's declared request schemas and body. */
export type RouteInputReader = (
  route: ParamExtractionRoute,
) => (c: Context) => Promise<RouteInputValues>;

// Installed by `@Body`, `@Query` and `@Param`, whose module ships schema
// validation, so an application that declares none of them never bundles it.
let inputReader: RouteInputReader | undefined;

/** Install the reader that validates declared request schemas and bodies. */
export function installRouteInput(reader: RouteInputReader): void {
  inputReader = reader;
}

/** The reader for declared request schemas, once a parameter decorator installed it. */
export function routeInputReader(): RouteInputReader | undefined {
  return inputReader;
}

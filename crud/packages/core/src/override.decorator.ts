/**
 * `@Override(verb)` — first-class takeover of one generated verb: `@Crud()`
 * skips synthesis for it and stamps the verb's route, route name, and OpenAPI
 * metadata onto YOUR method instead. Your handler declares its own params
 * (`@CrudCtx()`, `@Param('id')`, `@Body()`, ...) and runs through the normal
 * pipeline like any hand-written route.
 */

import { recordOverride } from './stamp-routes';
import type { CrudEndpointName } from './verb-table';

export function Override(endpoint: CrudEndpointName): MethodDecorator {
  return (target, propertyKey) => {
    recordOverride((target as object).constructor, endpoint, propertyKey);
  };
}

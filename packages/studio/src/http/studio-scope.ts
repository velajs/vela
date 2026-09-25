import type { Type } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';

/**
 * The module instance that declares `controller`: for Studio's marker
 * controller, the StudioModule whose own tokens (`STUDIO_RESOLVED_CONFIG`, its
 * signers, dispatch registry and route holder) the admin surface reads. They
 * resolve in that scope, where Studio's registrations answer first: an
 * application-wide lookup of a token no module exports falls back to the first
 * module registering it, and a module a plugin imports registers before
 * StudioModule. `undefined` (an application-wide lookup) only when no module
 * declares the controller.
 */
export function declaringModuleId(container: Container, controller: Type): string | undefined {
  return container
    .getModuleDescriptions()
    .find(({ moduleId }) => container.getModuleScope(moduleId)?.controllers?.has(controller))
    ?.moduleId;
}

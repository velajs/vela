import type { Container } from './container';

// Internal read capability: teardown state includes the owning root and cannot
// be forged by seeding a provider or mutating an injected execution lifetime.
const availability = new WeakMap<Container, () => boolean>();

export function registerContainerAvailability(container: Container, read: () => boolean): void {
  availability.set(container, read);
}

export function isContainerAvailable(container: Container): boolean {
  return availability.get(container)?.() === true;
}

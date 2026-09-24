import { defineModule, InjectionToken, type ModuleRegistrationOptions } from '@velajs/vela';
import {
  DiscoveryService,
  referenceKey,
  sideEffectModule,
  type DiscoveredRegistration,
} from '@velajs/vela/module-kit';

const NUMBER = new InjectionToken<number>('module number');
const { ConfigurableModuleClass: Feature } = defineModule<{ name: string; http?: boolean }, 'http'>(
  {
    name: 'PackageFeature',
    structural: ['http'],
    key: (options) => referenceKey(options.http),
  },
);
const registration: ModuleRegistrationOptions = { lazy: true, key: 'one' };
Feature.forRoot({ name: 'one', ...registration });
Feature.forRootAsync({
  http: false,
  lazy: true,
  inject: [NUMBER],
  useFactory: (number) => ({ name: number.toFixed() }),
});
Feature.forRootAsync({
  inject: [NUMBER],
  // @ts-expect-error The injected dependency is a number, not a string.
  useFactory: (number) => ({ name: number.toUpperCase() }),
});
// @ts-expect-error Structural option values retain their declared types.
Feature.forRootAsync({ http: 'false', useFactory: () => ({ name: 'one' }) });
// @ts-expect-error Non-structural options come from the factory.
Feature.forRootAsync({ name: 'one', useFactory: () => ({ name: 'one' }) });
defineModule<{ name: string; http?: boolean }, 'http'>({
  name: 'SetupReadsStructural',
  structural: ['http'],
  // @ts-expect-error setup sees only the structural options.
  setup: ({ options }) => ({ exports: options.name ? [] : [] }),
});
class Contributions {}
sideEffectModule(Contributions);

function registrations(discovery: DiscoveryService): DiscoveredRegistration[] {
  return discovery.getRegistrations({ metadataOnly: true });
}
void registrations;

// Forwarded partial bags historically allow explicit undefined, even when the
// consumer enables exactOptionalPropertyTypes. The factory returns the rest.
const structural: { http?: boolean | undefined } = { http: undefined };
Feature.forRootAsync({ ...structural, useFactory: () => ({ name: 'forwarded' }) });

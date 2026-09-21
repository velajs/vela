import {
  defineModule,
  DiscoveryService,
  InjectionToken,
  sideEffectModule,
  type DiscoveredRegistration,
  type ModuleRegistrationOptions,
} from '@velajs/vela';

const NUMBER = new InjectionToken<number>('module number');
const { ConfigurableModuleClass: Feature } = defineModule<{ name: string; http?: boolean }>({
  name: 'PackageFeature',
});
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
Feature.forRootAsync({ http: 'false', inject: [], useFactory: () => ({ name: 'one' }) });
class Contributions {}
sideEffectModule(Contributions);

function registrations(discovery: DiscoveryService): DiscoveredRegistration[] {
  return discovery.getRegistrations({ metadataOnly: true });
}
void registrations;

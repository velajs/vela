import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { SEEDER_METADATA } from './seeder.tokens';
import type { SeederMetadata } from './seeder.types';

/**
 * Mark a class as a seeder. Also marks it `@Injectable()` (singleton unless
 * `@Injectable({ scope })` says otherwise) so it only needs to be listed in a
 * module's providers (or `SeederModule.forRoot({ seeders })`) to be discovered
 * by {@link SeederRegistry} at bootstrap.
 */
export function Seeder(options: SeederMetadata = {}): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    MetadataRegistry.markInjectable(ctor);
    MetadataRegistry.setCustomClassMeta(target, SEEDER_METADATA, options);
  };
}

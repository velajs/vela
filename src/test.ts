import { METADATA_KEYS, MetadataRegistry } from '@velajs/vela';
import type { ModuleOptions } from '@velajs/vela';
import { TestingModuleBuilder } from './testing-module.builder.js';

export const Test = {
  createTestingModule(metadata: ModuleOptions): TestingModuleBuilder {
    class TestModule {}
    Reflect.defineMetadata(METADATA_KEYS.MODULE, true, TestModule);
    MetadataRegistry.setModuleOptions(TestModule, metadata);
    return new TestingModuleBuilder(TestModule);
  },
};

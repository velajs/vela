import type { ModuleOptions } from '@velajs/vela';
import { TestingModuleBuilder } from './testing-module.builder.js';

export const Test = {
  createTestingModule(metadata: ModuleOptions): TestingModuleBuilder {
    return new TestingModuleBuilder(metadata);
  },
};

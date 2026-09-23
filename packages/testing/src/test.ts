import type { ModuleOptions } from '@velajs/vela';
import { TestingModuleBuilder, type TestingModuleOptions } from './testing-module.builder.js';

export const Test = {
  /** Build a testing module; `options` seeds ENV and binds runtime adapters. */
  createTestingModule(
    metadata: ModuleOptions,
    options: TestingModuleOptions = {},
  ): TestingModuleBuilder {
    return new TestingModuleBuilder(metadata, options);
  },
};

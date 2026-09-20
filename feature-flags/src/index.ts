// Public surface of @velajs/feature-flags (the `.` entry). Server-only: no
// React, no client hooks. Runtime-specific drivers (Cloudflare Flagship / KV)
// ship from @velajs/cloudflare against the FeatureFlagDriver contract exported
// here.

// --- DI: module / service / tokens ---------------------------------------
export { FeatureFlagsModule } from './feature-flags.module';
export { FeatureFlagsService } from './feature-flags.service';
export { FEATURE_FLAG_TOKENS } from './feature-flags.tokens';

// --- Driver contract + in-package driver + registry -----------------------
export type { FeatureFlagDriver } from './drivers/driver';
export { MemoryFlagDriver, memoryFlagDriver } from './drivers/memory.driver';
export type { MemoryFlagDriverOptions } from './drivers/memory.driver';
export { FeatureFlagDriverRegistry, buildDriverRegistry } from './drivers/registry';

// --- Guard + decorator ----------------------------------------------------
export { FeatureFlagGuard } from './guards/feature-flag.guard';
export { FeatureFlag, FEATURE_FLAG_METADATA } from './decorators/feature-flag.decorator';
export type {
  FeatureFlagOptions,
  FeatureFlagMetadata,
  FeatureFlagDisabledBehavior,
} from './decorators/feature-flag.decorator';

// --- Errors ---------------------------------------------------------------
export { FeatureFlagError } from './feature-flags.error';

// --- Types ----------------------------------------------------------------
export type {
  FeatureFlagsOptions,
  FeatureFlagRegistry,
  FlagContext,
  FlagKey,
  FlagManifest,
  FlagValue,
  FlagEvaluationDetails,
  FlagEvaluationReason,
} from './feature-flags.types';

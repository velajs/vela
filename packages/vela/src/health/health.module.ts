import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { DEFAULT_MODULE_KEY } from '../module/module-identity';
import { HealthCheckService } from './health.service';
import { HealthIndicatorService } from './health.indicator';
import { HttpHealthIndicator } from './health.http';

/** `HealthModule` takes no options; `forRoot()` is the uniform entry. */
export type HealthModuleOptions = Record<never, never>;

// The bare import's key: `forRoot()` and `imports: [HealthModule]` are one instance.
const { ConfigurableModuleClass } = defineModule<HealthModuleOptions>({
  name: 'Health',
  key: () => DEFAULT_MODULE_KEY,
});

@Module({
  providers: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
  exports: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
})
export class HealthModule extends ConfigurableModuleClass {}

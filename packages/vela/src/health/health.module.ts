import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { HealthCheckService } from './health.service';
import { HealthIndicatorService } from './health.indicator';
import { HttpHealthIndicator } from './health.http';

/** `HealthModule` takes no options; `forRoot()` is the uniform entry. */
export type HealthModuleOptions = Record<never, never>;

const { ConfigurableModuleClass } = defineModule<HealthModuleOptions>({ name: 'Health' });

@Module({
  providers: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
  exports: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
})
export class HealthModule extends ConfigurableModuleClass {}

// @velajs/vela/health — health checks and indicators.
import '../metadata';

export { HealthModule } from './health.module';
export type { HealthModuleOptions } from './health.module';
export { HealthCheckService, HealthCheckException } from './health.service';
export { HealthIndicatorService } from './health.indicator';
export { HttpHealthIndicator } from './health.http';
export type {
  HealthCheckResult,
  HealthCheckStatus,
  HealthIndicatorResult,
  HealthIndicatorFunction,
  ResponseCheckCallback,
} from './health.types';
export type { HttpPingOptions } from './health.http';

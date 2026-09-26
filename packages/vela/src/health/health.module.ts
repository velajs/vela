import { Module } from '../module/decorators';
import { HealthCheckService } from './health.service';
import { HealthIndicatorService } from './health.indicator';
import { HttpHealthIndicator } from './health.http';

@Module({
  providers: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
  exports: [HealthCheckService, HealthIndicatorService, HttpHealthIndicator],
})
export class HealthModule {}

import { Injectable } from '../container/index';
import { ServiceUnavailableException } from '../errors/http-exception';
import type { BeforeApplicationShutdown } from '../lifecycle/index';
import type {
  HealthCheckResult,
  HealthIndicatorFunction,
  HealthIndicatorResult,
} from './health.types';

@Injectable()
export class HealthCheckService implements BeforeApplicationShutdown {
  private isShuttingDown = false;

  beforeApplicationShutdown(): void {
    this.isShuttingDown = true;
  }

  async check(indicators: HealthIndicatorFunction[]): Promise<HealthCheckResult> {
    if (this.isShuttingDown) {
      const result: HealthCheckResult = { status: 'shutting_down', info: {}, error: {}, details: {} };
      throw new ServiceUnavailableException({ ...result });
    }

    const results = await Promise.allSettled(indicators.map((fn) => fn()));

    const info: HealthIndicatorResult = {};
    const error: HealthIndicatorResult = {};
    const details: HealthIndicatorResult = {};

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const indicatorResult = result.value;
        for (const [key, value] of Object.entries(indicatorResult)) {
          details[key] = value;
          if (value.status === 'up') {
            info[key] = value;
          } else {
            error[key] = value;
          }
        }
      } else {
        const message = result.reason instanceof Error
          ? result.reason.message
          : 'Health check failed';
        const key = 'unknown';
        const value = { status: 'down' as const, message };
        details[key] = value;
        error[key] = value;
      }
    }

    const status = Object.keys(error).length > 0 ? 'error' : 'ok';
    const checkResult: HealthCheckResult = { status, info, error, details };

    if (status === 'error') {
      throw new ServiceUnavailableException({ ...checkResult });
    }

    return checkResult;
  }
}

import { Injectable } from '../container/index';
import type { HealthIndicatorResult } from './health.types';

interface HealthIndicatorBuilder {
  up(data?: Record<string, unknown>): HealthIndicatorResult;
  down(data?: Record<string, unknown>): HealthIndicatorResult;
}

@Injectable()
export class HealthIndicatorService {
  check(key: string): HealthIndicatorBuilder {
    return {
      up(data?: Record<string, unknown>): HealthIndicatorResult {
        return { [key]: { status: 'up', ...data } };
      },
      down(data?: Record<string, unknown>): HealthIndicatorResult {
        return { [key]: { status: 'down', ...data } };
      },
    };
  }
}
